/***** BEGIN LICENSE BLOCK *****

BSD License

Copyright (c) 2005-2015, NIF File Format Library and Tools
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. The name of the NIF File Format Library and Tools project may not be
   used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

***** END LICENCE BLOCK *****/

#include "xmlconfig.h"
#include "message.h"
#include "data/niftypes.h"
#include "model/nifmodel.h"

#include <QCoreApplication>
#include <QDir>
#include <QMessageBox>
#include <QSettings>
#include <QXmlStreamReader>


//! \file nifxml.cpp NifXmlHandler, NifModel XML

//! Set NifXmlHandler::errorStr and return
#define err( X ) { errorStr = X; return; }

QReadWriteLock             NifModel::XMLlock;
QList<quint32>             NifModel::supportedVersions;
QHash<QString, NifBlockPtr> NifModel::compounds;
QHash<QString, NifBlockPtr> NifModel::fixedCompounds;
QHash<QString, NifBlockPtr> NifModel::blocks;
QMap<quint32, NifBlockPtr> NifModel::blockHashes;
QList<NifModel::XmlOverlaySpec> NifModel::overlaySpecs;
QString                    NifModel::activeOverlaySpec;


// Current token attribute list
QString attrlist;
// Token storage
QMap<QString, QVector<QPair<QString, QString>>> tokens;
// Token storage of the XML overlay, replaced before the nif.xml tokens so that it can use them
QMap<QString, QVector<QPair<QString, QString>>> overlayTokens;

// Settings key of the XML overlay spec selection
static const char * overlaySpecKey = "XML/NIF-CS Spec";

//! Parses nif.xml
class NifXmlHandler final
{
//	Q_DECLARE_TR_FUNCTIONS(NifXmlHandler)

public:
	//! XML block types
	enum Tag
	{
		tagNone = 0,
		tagFile,
		tagVersion,
		tagCompound,
		tagBlock,
		tagAdd,
		tagAddDefault,
		tagBasic,
		tagEnum,
		tagOption,
		tagBitFlag,
		tagBitfield,
		tagMember,
		tagToken,
		tagTokenTag,
		tagModule,
		tagVerAttr
	};

	//! i18n wrapper for various strings
	/*!
	 * Note that we don't use QObject::tr() because that doesn't provide
	 * context. We also don't use the QCoreApplication Q_DECLARE_TR_FUNCTIONS()
	 * macro because that won't document properly.
	 */
	static inline QString tr( const char * key, const char * comment = 0 ) { return QCoreApplication::translate( "NifXmlHandler", key, comment ); }

	//! Constructor
	/*!
	 * \param overlay Parse an XML overlay (NIF-CS.xml) on top of the already parsed nif.xml.
	 * An overlay may declare new types like nif.xml, and patch existing ones with patch="true":
	 * - enum / bitflags: each option adds or replaces the option with the same value.
	 * - niobject / struct: each field is one of these operations, applied in document order:
	 *   - rename="New Name" [hide="true"] cond="..." [vercond="..."]: show the existing field (all
	 *     fields named "name") as "New Name" while the conditions hold. Display-only, the field and
	 *     its value are unchanged. The text of the element replaces the description while renamed.
	 *     With hide="true" (rename optional), the field is also hidden in the tree view.
	 *     With value="N", the enum option N of the field is renamed instead of the field.
	 *   - andcond="..." [vercond="..."]: the existing field is only present if this condition also
	 *     holds. With vercond, the restriction only applies to the versions matching vercond.
	 *   - after="Existing Field" plus the usual field attributes: insert a new field after the
	 *     last field named "Existing Field" (and after fields inserted there before).
	 *     With hide="true", the new field is always hidden in the tree view.
	 */
	NifXmlHandler( bool overlay = false ) : isOverlay( overlay )
	{
		tags.insert( "niftoolsxml", tagFile );
		tags.insert( "version", tagVersion );
		tags.insert( "module", tagModule );
		tags.insert( "struct", tagCompound );
		tags.insert( "niobject", tagBlock );
		tags.insert( "field", tagAdd );
		tags.insert( "default", tagAddDefault );
		tags.insert( "basic", tagBasic );
		tags.insert( "enum", tagEnum );
		tags.insert( "option", tagOption );
		tags.insert( "bitflags", tagBitFlag );
		tags.insert( "token", tagToken );
		tags.insert( "bitfield", tagBitfield );
		tags.insert( "member", tagMember );
		tags.insert( "verattr", tagVerAttr );

		if ( isOverlay )
			overlayTokens.clear();
		else
			tokens.clear();
	}

	//! Field operations of a patch (see constructor)
	enum PatchOp
	{
		opNone = 0,
		opRename,
		opAndCond,
		opInsert
	};

	//! Parsing an XML overlay
	bool isOverlay = false;
	//! Description of the active overlay spec, stored with renamed fields
	QString overlayOrigin;
	//! The current niobject, struct, enum or bitflags patches an existing declaration
	bool isPatch = false;
	//! Operation of the current patch field
	PatchOp patchOp = opNone;
	//! Name of the existing field that the current patch field renames, restricts, or is inserted after
	QString patchTarget;
	//! New name, condition and version condition of the current patch field
	QString patchRename;
	QString patchCond;
	QString patchVerCond;
	//! The current patch field hides the field (hide="true"), or renames an enum option of it (value="...")
	bool patchHide = false;
	QString patchValue;
	//! Next insertion index in the patched block, by the name of the field to insert after
	QHash<QString, int> patchInsertPos;

	//! Current position on stack
	int depth = 0;
	//! Tag stack
	Tag stack[10] = {};
	//! Hashmap of tags
	QHash<QString, Tag> tags;
	//! Error string
	QString errorStr;

	//! Current type ID
	QString typId;
	//! Current type description
	QString typTxt;

	//! Current enumeration ID
	QString optId;
	//! Current enumeration value
	QString optVal;
	//! Current enumeration bit
	QString optBit;
	//! Current enumeration text
	QString optTxt;

	//! Block
	NifBlockPtr blk = nullptr;
	//! Data
	NifData data;

	//! The current tag
	Tag current() const
	{
		return stack[depth - 1];
	}
	//! Add a tag to the stack
	void push( Tag x )
	{
		stack[depth++] = x;
	}
	//! Get a tag from the stack
	Tag pop()
	{
		return stack[--depth];
	}

	static void replaceTokens( QString & str, const QMap<QString, QVector<QPair<QString, QString>>> & tokenMap, const QString & attr )
	{
		auto it = tokenMap.constFind( attr );
		if ( it == tokenMap.constEnd() )
			return;

		for ( const auto& p : *it )
			if ( p.second == "INFINITY" )
				str.replace(p.first, "0x7F800000");
			else
				str.replace( p.first, p.second );
	}

	/*!
	 * \param attr Attribute to read
	 * \param tokenAttr Attribute whose tokens to replace, if it differs from attr
	 */
	QString token_replace( const QXmlStreamAttributes & list, const QString & attr, const QString & tokenAttr = QString() )
	{
		QString str = list.value( attr ).toString();
		const QString & a = tokenAttr.isEmpty() ? attr : tokenAttr;
		if ( isOverlay )
			replaceTokens( str, overlayTokens, a );
		replaceTokens( str, tokens, a );
		return str;
	}

	//! Does the patched block have a field with this name?
	bool patchHasField( const QString & name ) const
	{
		for ( const NifData & d : blk->types ) {
			if ( d.name() == name )
				return true;
		}
		return false;
	}

	//! Is an attribute value "1" or "true"?
	template <typename T>
	static bool isTrue( const T & v )
	{
		return ( v == QLatin1StringView("1") || v == QLatin1StringView("true") );
	}

	//! Is the element a patch of an existing declaration (patch="true")?
	static bool isPatchElement( const QXmlStreamAttributes & list )
	{
		return isTrue( list.value( QLatin1StringView("patch") ) );
	}

	/*!
	 * \param tagid Qualified name
	 * \param list Attributes
	 */
	void startElement( const QString & tagid, const QXmlStreamAttributes & list )
	{
		if ( depth >= 8 )
			err( tr( "error maximum nesting level exceeded" ) );

		Tag x = tags.value( tagid );

		// Token Replace lambda, use get(x) instead of list.value(x)
		auto get = [this, &list]( const QString & attr ) {
			return token_replace( list, attr );
		};

		if ( x == tagToken )
			tags.insert( list.value( QLatin1StringView("name") ).toString(), tagTokenTag );

		if ( x == tagNone ) {
			x = tags.value( tagid );
			if ( x == tagNone )
				err( tr( "error unknown element '%1'" ).arg( tagid ) );
		}

		if ( depth == 0 ) {
			if ( x != tagFile )
				err( tr( "this is not a niftoolsxml file" ) );

			push( x );
			return;
		}

		switch ( current() ) {
		case tagFile:
			push( x );

			if ( isPatchElement( list ) ) {
				if ( !isOverlay )
					err( tr( "patch=\"true\" is only allowed in an XML overlay" ) );

				QString name = list.value( QLatin1StringView("name") ).toString();
				switch ( x ) {
				case tagCompound:
				case tagBlock:
					blk = ( x == tagBlock ) ? NifModel::blocks.value( name ) : NifModel::compounds.value( name );
					if ( !blk )
						err( tr( "patch of undeclared %1 %2" ).arg( tagid, name ) );
					break;
				case tagEnum:
				case tagBitFlag:
					if ( NifValue::enumType( name ) == NifValue::eNone )
						err( tr( "patch of undeclared %1 %2" ).arg( tagid, name ) );
					typId = name;
					typTxt = QString();
					break;
				default:
					err( tr( "patch=\"true\" is not supported for %1" ).arg( tagid ) );
				}

				isPatch = true;
				patchInsertPos.clear();
				break;
			}

			switch ( x ) {
			case tagCompound:
			case tagBlock:
				{
					QString name = list.value( QLatin1StringView("name") ).toString();

					if ( NifValue::type( name ) != NifValue::tNone ) {
						// Internal Type
						typId  = name;
						typTxt = QString();
					} else {
						QString id = name;

						if ( x == tagCompound && NifValue::isValid( NifValue::type( id ) ) )
							err( tr( "struct %1 is already registered as internal type" ).arg( list.value( QLatin1StringView("name") ) ) );

						if ( id.isEmpty() )
							err( tr( "struct and niblocks must have a name" ) );

						if ( NifModel::compounds.contains( id ) || NifModel::blocks.contains( id ) )
							err( tr( "multiple declarations of %1" ).arg( id ) );

						if ( !blk )
							blk = NifBlockPtr( new NifBlock );

						blk->id = id;
						if ( auto v = list.value( QLatin1StringView("abstract") ); true )
							blk->abstract = ( v == QLatin1StringView("1") || v == QLatin1StringView("true") );

						if ( x == tagBlock ) {
							blk->ancestor = list.value( QLatin1StringView("inherit") ).toString();

							if ( !blk->ancestor.isEmpty() ) {
								if ( !NifModel::blocks.contains( blk->ancestor ) )
									err( tr( "forward declaration of block id %1" ).arg( blk->ancestor ) );
							}
						}

						QString externalCond = list.value( QLatin1StringView("externalcond") ).toString();
						if ( externalCond == "1" || blk->id.startsWith( "BSVertexData" ) ) {
							NifModel::fixedCompounds.insert( blk->id, blk );
						}
					}
				}
				break;
			case tagBasic:
				{
					QString name = list.value( QLatin1StringView("name") ).toString();

					if ( NifValue::type( name ) == NifValue::tNone )
						err( tr( "basic definition %1 must have an internal NifSkope type" ).arg( name ) );

					typId = name;
					typTxt = QString();
				}
				break;
			case tagEnum:
			case tagBitFlag:
				{
					typId  = list.value( QLatin1StringView("name") ).toString();
					typTxt = QString();
					QString storage = list.value( QLatin1StringView("storage") ).toString();

					if ( typId.isEmpty() || storage.isEmpty() )
						err( tr( "enum definition must have a name and a known storage type" ) );

					if ( !NifValue::registerAlias( typId, storage ) )
						err( tr( "failed to register alias %1 for enum type %2" ).arg( storage, typId ) );

					NifValue::EnumType flags = (x == tagBitFlag) ? NifValue::eFlags : NifValue::eDefault;
					NifValue::registerEnumType( typId, flags );
				}
				break;
			case tagBitfield:
				{
					typId = list.value( QLatin1StringView("name") ).toString();
					typTxt = QString();
					QString storage = list.value( QLatin1StringView("storage") ).toString();

					if ( typId.isEmpty() || storage.isEmpty() )
						err( tr( "bitfield definition must have a name and a known storage type" ) );

					if ( !NifValue::registerAlias( typId, storage ) )
						err( tr( "failed to register alias %1 for enum type %2" ).arg( storage, typId ) );
				}
				break;
			case tagVersion:
				{
					int v = NifModel::version2number( list.value( QLatin1StringView("num") ).toString().trimmed() );

					if ( v != 0 && !list.value( QLatin1StringView("num") ).isEmpty() )
						NifModel::supportedVersions.append( v );
					else
						err( tr( "invalid version tag" ) );
				}
				break;
			case tagToken:
				{
					attrlist = list.value( QLatin1StringView("attrs") ).toString();
				}
				break;
			case tagModule:
			case tagVerAttr: // Unused Metadata
				break;
			default:
				err( tr( "expected basic, enum, struct, niobject or version got %1 instead" ).arg( tagid ) );
			}

			break;
		case tagVersion:
			//err( tr("version tag must not contain any sub tags") );
			break;
		case tagCompound:

			if ( x != tagAdd )
				err( tr( "only field tags allowed in struct type declaration" ) );
			[[fallthrough]];

		case tagBlock:
			push( x );

			switch ( x ) {
			case tagAdd:
				patchOp = opNone;
				if ( isPatch ) {
					patchTarget = list.value( QLatin1StringView("name") ).toString();
					patchRename = list.value( QLatin1StringView("rename") ).toString();
					patchHide = isTrue( list.value( QLatin1StringView("hide") ) );
					patchValue = list.value( QLatin1StringView("value") ).toString();
					QString andCond = token_replace( list, "andcond", "cond" );
					QString after = list.value( QLatin1StringView("after") ).toString();
					bool isAlias = !patchRename.isEmpty() || ( patchHide && after.isEmpty() );

					if ( int( isAlias ) + int( !andCond.isEmpty() ) + int( !after.isEmpty() ) != 1 )
						err( tr( "patch field %1 in %2 needs exactly one of the attributes rename/hide, andcond or after" ).arg( patchTarget, blk->id ) );

					if ( !patchValue.isEmpty() ) {
						bool ok = false;
						patchValue.toUInt( &ok, 0 );
						if ( !ok || patchRename.isEmpty() || patchHide )
							err( tr( "patch field %1 in %2: value needs a number and rename, and cannot hide" ).arg( patchTarget, blk->id ) );
					}

					if ( !after.isEmpty() ) {
						// Insert a new field: parsed like any other field below
						patchOp = opInsert;
						patchTarget = after;
						if ( !patchHasField( patchTarget ) )
							err( tr( "%1 has no field %2 to insert after" ).arg( blk->id, patchTarget ) );
					} else {
						if ( !patchHasField( patchTarget ) )
							err( tr( "%1 has no field %2 to patch" ).arg( blk->id, patchTarget ) );

						if ( isAlias ) {
							patchOp = opRename;
							patchCond = get( "cond" );
						} else {
							patchOp = opAndCond;
							patchCond = andCond;
						}
						patchVerCond = get( "vercond" );

						// Only collects the description text, applied in endElement
						data = NifData( patchTarget );
						break;
					}
				}

				{
					QString type = list.value( QLatin1StringView("type") ).toString();
					QString tmpl = list.value( QLatin1StringView("template") ).toString();
					QString arg  = get( "arg" );
					QString arr1 = get( "length" );
					QString arr2 = get( "width" );
					QString cond = get( "cond" );
					QString ver1 = list.value( QLatin1StringView("since") ).toString();
					QString ver2 = list.value( QLatin1StringView("until") ).toString();
					QString abs = list.value( QLatin1StringView("abstract") ).toString();
					QString bin = list.value( QLatin1StringView("binary") ).toString();
					QString vercond = get( "vercond" );
					QString defval = get( "default" );

					bool hasTypeCondition = false;

					QString onlyT = list.value( QLatin1StringView("onlyT") ).toString();
					QString excludeT = list.value( QLatin1StringView("excludeT") ).toString();
					if ( !onlyT.isEmpty() || !excludeT.isEmpty() ) {
						Q_ASSERT( cond.isEmpty() );
						Q_ASSERT( onlyT.isEmpty() != excludeT.isEmpty() );
						// hasTypeCondition flag here relies on that cond is always either "cond" attribute or "onlyT/excludeT", not a combination of both at the same time.
						// If it ever changes, hasTypeCondition logic will have to be rewritten.
						hasTypeCondition = true;
						if ( !onlyT.isEmpty() )
							cond = onlyT;
						else
							cond = QString( "!%1" ).arg( excludeT );
					}


					bool isTemplated = (type == XMLTMPL || tmpl == XMLTMPL);
					bool isCompound = NifModel::compounds.contains( type );
					bool isArray = !arr1.isEmpty();
					bool isMultiArray = !arr2.isEmpty();
					if ( isMultiArray && !isArray )
						err( tr("\"width\" attribute without \"length\" attribute") );

					// Override some compounds as mixins (compounds without nesting)
					//	This flattens the hierarchy as if the mixin's <add> rows belong to the mixin's parent
					//	This only takes place on a per-row basis and reverts to nesting when in an array.
					bool isMixin = false;
					if ( isCompound ) {
						static const QVector<QString> mixinTypes {
							"HavokFilter",
							"HavokMaterial",
							"bhkRagdollConstraintCInfo",
							"bhkLimitedHingeConstraintCInfo",
							"bhkHingeConstraintCInfo",
							"bhkBallAndSocketConstraintCInfo",
							"bhkPrismaticConstraintCInfo",
							"bhkMalleableConstraintCInfo",
							"bhkConstraintData",
							"bhkConstraintCInfo"
						};

						isMixin = mixinTypes.contains( type );
						// The <add> must not use any attributes other than name/type
						isMixin = isMixin && !isTemplated && !isArray;
						isMixin = isMixin && cond.isEmpty() && ver1.isEmpty() && ver2.isEmpty() && vercond.isEmpty();

						isCompound = !isMixin;
					}

					// Special casing for BSVertexDesc as an ARG
					// since we have internalized the type
					if ( arg == "Vertex Desc\\Vertex Attributes" )
						arg = "Vertex Desc";

					// now allocate
					data = NifData(
						list.value( QLatin1StringView("name") ).toString(),
						type,
						tmpl,
						NifValue( NifValue::type( type ) ),
						arg,
						arr1,
						arr2,
						cond,
						NifModel::version2number( ver1 ),
						NifModel::version2number( ver2 )
					);

					// Set data flags
					data.setAbstract( abs == "1" || abs == "true" );
					data.setBinary( bin == "1" || bin == "true" );
					data.setTemplated( isTemplated );
					data.setIsCompound( isCompound );
					data.setIsArray( isArray );
					data.setIsMultiArray( isMultiArray );
					data.setIsMixin( isMixin );
					data.setHasTypeCondition( hasTypeCondition );

					if ( data.isBinary() && isMultiArray )
						err( tr("Binary multi-arrays not supported") );

					if ( !defval.isEmpty() ) {
						bool ok;
						quint32 enumVal = NifValue::enumOptionValue( type, defval, &ok );

						if ( ok ) {
							data.setCount( enumVal, nullptr, nullptr );
						} else {
							data.setFromString( defval, nullptr, nullptr );
						}
					}

					if ( !vercond.isEmpty() ) {
						data.setVerCond( vercond );
					}

					// Set conditionless flag on data
					if ( cond.isEmpty() && vercond.isEmpty() && ver1.isEmpty() && ver2.isEmpty() )
						data.setIsConditionless( true );

					if ( data.name().isEmpty() || data.type().isEmpty() )
						err( tr( "field needs at least name and type attributes" ) );
				}
				break;
			default:
				err( tr( "only field tags allowed in block declaration" ) );
			}

			break;
		case tagAdd:
			// Member child tags
			push( x );
			switch ( x ) {
			case tagAddDefault:
				// Subclass defaults
				break;
			default:
				break;
			}
			break;
		case tagEnum:
		case tagBitFlag:
			push( x );

			switch ( x ) {
			case tagOption:
				optId  = list.value( QLatin1StringView("name") ).toString();
				optVal = list.value( QLatin1StringView("value") ).toString();
				optBit = list.value( QLatin1StringView("bit") ).toString();
				if ( !optBit.isEmpty() )
					optVal = optBit;

				optTxt = QString();

				if ( optId.isEmpty() || optVal.isEmpty() )
					err( tr( "option defintion must have a name and a value" ) );

				bool ok;
				optVal.toUInt( &ok, 0 );

				if ( !ok )
					err( tr( "option value error (only integers please)" ) );

				break;
			default:
				err( tr( "only option tags allowed in enum declaration" ) );
			}

			break;
		case tagBitfield:
			push( x );
			switch ( x ) {
			case tagMember:
				break;
			default:
				err( tr( "only member tags allowed in bitfield declaration" ) );
			}
			break;
		case tagToken:
			push( x );
			switch ( x ) {
			case tagTokenTag:
				{
					auto tok = list.value( QLatin1StringView("token") ).toString();
					auto str = list.value( QLatin1StringView("string") ).toString();
					auto & tokenMap = isOverlay ? overlayTokens : tokens;
					for ( const auto & attr : attrlist.split( " " ) ) {
						if ( !tokenMap.contains(attr) )
							tokenMap[attr] = {};

						tokenMap[attr].append( {tok, str} );
					}
				}
				break;
			default:
				err( tr( "only token tags allowed in token declaration" ) );;
			}
			break;
		case tagVerAttr:
			// Unused Metadata
			break;
		default:
			err( tr( "error unhandled tag %1" ).arg( tagid ) );
			break;
		}
	}

	//! Logical AND of two condition strings (with operator tokens already replaced)
	static QString joinConditions( const QString & a, const QString & b )
	{
		return a.isEmpty() ? QString( "(%1)" ).arg( b ) : QString( "(%1) && (%2)" ).arg( a, b );
	}

	//! Applies the field that just ended in a patched niobject or struct (see constructor)
	void applyPatchField()
	{
		switch ( patchOp ) {
		case opRename:
			{
				NifFieldAlias alias;
				alias.name = patchRename.isEmpty() ? patchTarget : patchRename;
				alias.hidden = patchHide;
				if ( !patchValue.isEmpty() ) {
					alias.isValueAlias = true;
					alias.value = patchValue.toUInt( nullptr, 0 );
				}
				alias.text = data.text();
				alias.origin = overlayOrigin;
				alias.cond = patchCond;
				alias.condexpr = NifExpr( patchCond );
				alias.vercond = patchVerCond;
				alias.verexpr = NifExpr( patchVerCond );

				for ( NifData & d : blk->types ) {
					if ( d.name() == patchTarget )
						d.addAlias( alias );
				}
			}
			break;
		case opAndCond:
			for ( int i = 0; i < blk->types.size(); i++ ) {
				if ( blk->types.at( i ).name() != patchTarget )
					continue;
				if ( blk->types.at( i ).hasTypeCondition() )
					err( tr( "andcond is not supported for field %1 of %2 (onlyT/excludeT)" ).arg( patchTarget, blk->id ) );

				NifData restricted = blk->types.at( i );
				restricted.setCond( joinConditions( restricted.cond(), patchCond ) );
				restricted.setIsConditionless( false );

				if ( patchVerCond.isEmpty() ) {
					blk->types[i] = restricted;
					continue;
				}

				// Restrict only the versions matching vercond: split the field into an unrestricted
				// copy for the other versions, followed by the restricted copy for these versions
				restricted.setVerCond( joinConditions( restricted.vercond(), patchVerCond ) );

				NifData & other = blk->types[i];
				other.setVerCond( joinConditions( other.vercond(), QString( "!(%1)" ).arg( patchVerCond ) ) );
				other.setIsConditionless( false );

				blk->types.insert( i + 1, restricted );
				for ( auto it = patchInsertPos.begin(); it != patchInsertPos.end(); ++it ) {
					if ( it.value() > i )
						it.value()++;
				}
				i++;
			}
			break;
		case opInsert:
			{
				int pos = patchInsertPos.value( patchTarget, -1 );
				if ( pos < 0 ) {
					for ( int i = blk->types.size() - 1; i >= 0; i-- ) {
						if ( blk->types.at( i ).name() == patchTarget ) {
							pos = i + 1;
							break;
						}
					}
				}
				if ( pos < 0 )
					err( tr( "%1 has no field %2 to insert after" ).arg( blk->id, patchTarget ) );

				if ( patchHide ) {
					// Always hidden in the tree view while present
					NifFieldAlias alias;
					alias.name = data.name();
					alias.hidden = true;
					alias.origin = overlayOrigin;
					data.addAlias( alias );
				}

				blk->types.insert( pos, data );
				// Keep the pending insertion points behind the new field
				for ( auto it = patchInsertPos.begin(); it != patchInsertPos.end(); ++it ) {
					if ( it.value() >= pos )
						it.value()++;
				}
				patchInsertPos[patchTarget] = pos + 1;
			}
			break;
		default:
			break;
		}

		patchOp = opNone;
	}

	/*!
	 * \param tagid Qualified name
	 */
	void endElement( const QString & tagid )
	{
		if ( depth <= 0 )
			err( tr( "mismatching end element tag for element %1" ).arg( tagid ) );

		Tag x = tags.value( tagid );

		if ( pop() != x )
			err( tr( "mismatching end element tag for element %1" ).arg( tagid ) );

		if ( isPatch && depth == 1 ) {
			// End of a patch: the declaration is already registered, and its description is kept
			blk = nullptr;
			isPatch = false;
			return;
		}

		switch ( x ) {
		case tagCompound:
			if ( blk && !blk->id.isEmpty() && !blk->text.isEmpty() )
				NifValue::setTypeDescription( blk->id, blk->text );
			else if ( !typId.isEmpty() && !typTxt.isEmpty() )
				NifValue::setTypeDescription( typId, typTxt );
			[[fallthrough]];

		case tagBlock:
			if ( blk ) {
				if ( blk->id.isEmpty() ) {
					blk = nullptr;
					err( tr( "invalid %1 declaration: name is empty" ).arg( tagid ) );
				}

				switch ( x ) {
				case tagCompound:
					NifModel::compounds.insert( blk->id, blk );
					break;
				case tagBlock:
					NifModel::blocks.insert( blk->id, blk );
					NifModel::blockHashes.insert( DJB1Hash(blk->id.toStdString().c_str()), blk );
					break;
				default:
					break;
				}

				blk = 0;
			}

			break;
		case tagAdd:
			if ( isPatch ) {
				applyPatchField();
			} else if ( blk ) {
				blk->types.append( data );
			}

			break;
		case tagOption:
			{
				bool ok;
				quint32 optValInt = optVal.toUInt( &ok, 0 );

				if ( !ok )
					err( tr( "failed to register enum option" ) );

				if ( isPatch ) {
					if ( !NifValue::replaceEnumOption( typId, optId, optValInt, optTxt ) )
						err( tr( "failed to replace enum option" ) );
				} else if ( !NifValue::registerEnumOption( typId, optId, optValInt, optTxt ) ) {
					err( tr( "failed to register enum option" ) );
				}
			}
			break;
		case tagBasic:
		case tagEnum:
		case tagBitFlag:
			NifValue::setTypeDescription( typId, typTxt );
		default:
			break;
		}
	}

	/*!
	 * \param s The character data
	 */
	void characters( const QString & s )
	{
		switch ( current() ) {
		case tagVersion:
			break;
		case tagCompound:
		case tagBlock:
			if ( isPatch )
				break;
			if ( blk )
				blk->text += s.trimmed();
			else
				typTxt += s.trimmed();

			break;
		case tagAdd:
			data.setText( data.text() + s.trimmed() );
			break;
		case tagBasic:
		case tagEnum:
		case tagBitFlag:
			typTxt += s.trimmed();
			break;
		case tagOption:
			optTxt += s.trimmed();
			break;
		default:
			break;
		}
	}

	//! Checks that the type of the data is valid
	bool checkType( const NifData & d )
	{
		return ( NifModel::compounds.contains( d.type() )
				|| NifValue::type( d.type() ) != NifValue::tNone
				|| d.type() == XMLTMPL
		);
	}

	//! Checks that a template type is valid
	bool checkTemp( const NifData & d )
	{
		return ( d.templ().isEmpty()
				|| NifValue::type( d.templ() ) != NifValue::tNone
				|| d.templ() == XMLTMPL
				|| NifModel::blocks.contains( d.templ() )
				|| NifModel::compounds.contains( d.templ() )
		);
	}

	void endDocument()
	{
		// make a rough check of the maps
		for ( const QString& key : NifModel::compounds.keys() ) {
			NifBlockPtr c = NifModel::compounds.value( key );
			for ( NifData data :c->types ) {
				if ( !checkType( data ) )
					err( tr( "struct type %1 refers to unknown type %2" ).arg( key, data.type() ) );

				if ( !checkTemp( data ) )
					err( tr( "struct type %1 refers to unknown template type %2" ).arg( key, data.templ() ) );

				if ( data.type() == key )
					err( tr( "struct type %1 contains itself" ).arg( key ) );
			}
		}

		for ( const QString& key : NifModel::blocks.keys() ) {
			NifBlockPtr b = NifModel::blocks.value( key );

			if ( !b->ancestor.isEmpty() && !NifModel::blocks.contains( b->ancestor ) )
				err( tr( "niobject %1 inherits unknown ancestor %2" ).arg( key, b->ancestor ) );

			if ( b->ancestor == key )
				err( tr( "niobject %1 inherits itself" ).arg( key ) );

			for ( const NifData& data : b->types ) {
				if ( !checkType( data ) )
					err( tr( "niobject %1 refers to unknown type %2" ).arg( key, data.type() ) );

				if ( !checkTemp( data ) )
					err( tr( "niobject %1 refers to unknown template type %2" ).arg( key, data.templ() ) );
			}
		}
	}

	QString errorString() const
	{
		return errorStr;
	}
};

//! Find an XML file in the application folder (or the platform's shared data folder)
static QString findXmlFile( const QString & name )
{
	QDir        dir( QCoreApplication::applicationDirPath() );
	QStringList xmlList( QStringList()
						 << name
#ifdef Q_OS_LINUX
						 << ( "/usr/share/nifskope/" + name )
#endif
#ifdef Q_OS_MACOS
						 << ( "../../../" + name )
#endif
	);
	for ( const QString& str : xmlList ) {
		if ( dir.exists( str ) )
			return dir.filePath( str );
	}
	return QString();
}

// documented in nifmodel.h
bool NifModel::loadXML()
{
	QString fname = findXmlFile( "nif.xml" );
	QString result = NifModel::parseXmlDescription( fname );

	if ( !result.isEmpty() ) {
		Message::append( tr( "<b>Error loading XML</b><br/>You will need to reinstall the XML and restart the application." ), result, QMessageBox::Critical );
		return false;
	}

	// Optional overlay with third party additions (Community Shaders), kept out of nif.xml
	activeOverlaySpec.clear();
	QString overlayName = findXmlFile( overlayFileName );
	if ( overlayName.isEmpty() ) {
		overlaySpecs.clear();
		return true;
	}

	result = NifModel::parseXmlOverlay( overlayName );
	if ( !result.isEmpty() ) {
		Message::append( tr( "<b>Error loading %1</b><br/>Continuing with nif.xml only." ).arg( QString::fromLatin1( overlayFileName ) ), result, QMessageBox::Warning );

		// The overlay may be partly applied, start over without it
		result = NifModel::parseXmlDescription( fname );
		if ( !result.isEmpty() ) {
			Message::append( tr( "<b>Error loading XML</b><br/>You will need to reinstall the XML and restart the application." ), result, QMessageBox::Critical );
			return false;
		}
	}

	return true;
}

// documented in nifmodel.h
QString NifModel::overlaySpecSelection()
{
	return QSettings().value( overlaySpecKey ).toString();
}

// documented in nifmodel.h
void NifModel::setOverlaySpecSelection( const QString & version )
{
	QSettings().setValue( overlaySpecKey, version );
}

// documented in nifmodel.h
QString NifModel::parseXmlOverlay( const QString & filename )
{
	QWriteLocker lck( &XMLlock );

	overlaySpecs.clear();

	QFile f( filename );
	if ( !f.open( QIODevice::ReadOnly | QIODevice::Text ) )
		return tr( "Couldn't open XML overlay file: %1" ).arg( filename );

	// First pass: list the specs
	{
		QXmlStreamReader reader( &f );
		while ( !reader.atEnd() ) {
			reader.readNext();
			if ( reader.isStartElement() && reader.name() == QLatin1StringView("spec") ) {
				const QXmlStreamAttributes attrs = reader.attributes();
				XmlOverlaySpec spec;
				spec.version = attrs.value( QLatin1StringView("version") ).toString();
				spec.name = attrs.value( QLatin1StringView("name") ).toString();
				auto d = attrs.value( QLatin1StringView("default") );
				spec.isDefault = ( d == QLatin1StringView("1") || d == QLatin1StringView("true") );
				if ( spec.version.isEmpty() )
					return tr( "%1 XML parse error (line %2): spec without a version" ).arg( QString::fromLatin1( overlayFileName ) ).arg( reader.lineNumber() );
				if ( spec.name.isEmpty() )
					spec.name = tr( "v%1" ).arg( spec.version );
				overlaySpecs.append( spec );
			}
		}
		if ( reader.hasError() )
			return tr( "%1 XML parse error (line %2): %3" ).arg( QString::fromLatin1( overlayFileName ) ).arg( reader.lineNumber() ).arg( reader.errorString() );
	}

	// Pick the spec: the user's selection if it still exists, otherwise the default one
	QString selected = overlaySpecSelection();
	activeOverlaySpec.clear();
	if ( selected != QLatin1StringView( overlaySpecOff ) ) {
		for ( const XmlOverlaySpec & spec : overlaySpecs ) {
			if ( spec.version == selected )
				activeOverlaySpec = spec.version;
		}
		if ( activeOverlaySpec.isEmpty() ) {
			for ( const XmlOverlaySpec & spec : overlaySpecs ) {
				if ( spec.isDefault ) {
					activeOverlaySpec = spec.version;
					break;
				}
			}
		}
	}
	QString activeName;
	for ( const XmlOverlaySpec & spec : overlaySpecs ) {
		if ( spec.version == activeOverlaySpec )
			activeName = spec.name;
	}

	// Second pass: apply everything outside of <spec>, and the contents of the active spec
	f.seek( 0 );
	NifXmlHandler handler( true );
	QXmlStreamReader reader( &f );
	bool inSpec = false;
	while ( !reader.atEnd() && handler.errorStr.isEmpty() ) {
		reader.readNext();
		if ( reader.isStartElement() ) {
			if ( reader.name() == QLatin1StringView("spec") ) {
				if ( inSpec || handler.depth != 1 ) {
					handler.errorStr = tr( "spec must be a direct child of niftoolsxml" );
					break;
				}
				if ( reader.attributes().value( QLatin1StringView("version") ) != activeOverlaySpec ) {
					reader.skipCurrentElement();
					continue;
				}
				inSpec = true;
				handler.overlayOrigin = QString( "%1: %2" ).arg( QString::fromLatin1( overlayFileName ), activeName );
				continue;
			}
			handler.startElement( reader.name().toString(), reader.attributes() );
		} else if ( reader.isEndElement() ) {
			if ( inSpec && handler.depth == 1 && reader.name() == QLatin1StringView("spec") ) {
				inSpec = false;
				handler.overlayOrigin.clear();
				continue;
			}
			handler.endElement( reader.name().toString() );
		} else if ( reader.isCharacters() ) {
			handler.characters( reader.text().toString() );
		} else if ( reader.isEndDocument() ) {
			handler.endDocument();
		}
	}

	QString errorStr;
	if ( reader.hasError() ) {
		errorStr = reader.errorString();
		if ( errorStr.isEmpty() )
			errorStr = tr( "Syntax error" );
	} else {
		errorStr = handler.errorString();
	}

	if ( !errorStr.isEmpty() ) {
		activeOverlaySpec.clear();
		errorStr.prepend( tr( "%1 XML parse error (line %2): " ).arg( QString::fromLatin1( overlayFileName ) ).arg( reader.lineNumber() ) );
	}

	return errorStr;
}

// documented in nifmodel.h
QString NifModel::parseXmlDescription( const QString & filename )
{
	QWriteLocker lck( &XMLlock );

	compounds.clear();
	blocks.clear();

	supportedVersions.clear();

	NifValue::initialize();

	QFile f( filename );

	if ( !f.exists() )
		return tr( "nif.xml could not be found. Please install it and restart the application." );

	if ( !f.open( QIODevice::ReadOnly | QIODevice::Text ) )
		return tr( "Couldn't open NIF XML description file: %1" ).arg( filename );

	NifXmlHandler handler;
	QXmlStreamReader reader( &f );
	while ( !reader.atEnd() && handler.errorStr.isEmpty() ) {
		reader.readNext();
		if ( reader.isStartElement() )
			handler.startElement( reader.name().toString(), reader.attributes() );
		else if ( reader.isEndElement() )
			handler.endElement( reader.name().toString() );
		else if ( reader.isCharacters() )
			handler.characters( reader.text().toString() );
		else if ( reader.isEndDocument() )
			handler.endDocument();
	}

	QString	errorStr;
	if ( reader.hasError() ) {
		errorStr = reader.errorString();
		if ( errorStr.isEmpty() )
			errorStr = tr( "Syntax error" );
	} else {
		errorStr = handler.errorString();
	}

	if ( !errorStr.isEmpty() ) {
		errorStr.prepend( tr( "%1 XML parse error (line %2): " ).arg( "NIF" ).arg( reader.lineNumber() ) );

		compounds.clear();
		blocks.clear();
		supportedVersions.clear();
	}

	return errorStr;
}

