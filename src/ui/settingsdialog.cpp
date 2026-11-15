#include "settingsdialog.h"
#include "ui_settingsdialog.h"

#include "ui/settingspane.h"
#include "ui/settingssanitize.h"

#include <QDebug>
#include <QListWidget>
#include <QSettings>
#include <QStatusBar>

#include <algorithm>


//! @file settingsdialog.cpp SettingsDialog

SettingsDialog::SettingsDialog( QWidget * parent ) :
	QDialog( parent ),
	ui( new Ui::SettingsDialog )
{
	ui->setupUi( this );

	content = ui->content;
	categories = ui->categoryList;

	setWindowTitle( tr( "Settings" ) );
	setWindowFlags( Qt::Tool );
	setWindowModality( Qt::WindowModality::ApplicationModal );
	installEventFilter( this );

	content->addWidget( new SettingsGeneral( this ) );
	content->addWidget( new SettingsRender( this ) );
	content->addWidget( new SettingsResources( this ) );
	content->addWidget( new SettingsCommunityShaders( this ) );
	sanitizePane = new SettingsSanitize( this );
	content->addWidget( sanitizePane );

	// Widen the page list if needed, so that the longest page name (Community Shaders) is not elided.
	// The padding is that of res/style.qss: 10 on both sides of the list and of each item, 10 left of the text,
	// and some room to spare.
	int	textWidth = 0;
	for ( int i = 0; i < categories->count(); i++ )
		textWidth = std::max( textWidth, categories->fontMetrics().horizontalAdvance( categories->item( i )->text() ) );
	int	listWidth = textWidth + 70 + 2 * categories->frameWidth();
	if ( listWidth > categories->maximumWidth() ) {
		categories->setMinimumWidth( listWidth );
		categories->setMaximumWidth( listWidth );
	}

	categories->setCurrentRow( 0 );

	btnSave = ui->submit->button( QDialogButtonBox::Save );
	btnSave->setEnabled( false );

	btnApply = ui->submit->button( QDialogButtonBox::Apply );
	btnApply->setEnabled( false );

	btnCancel = ui->submit->button( QDialogButtonBox::Cancel );
	btnCancel->setEnabled( true );
	btnCancel->setText( tr("Close") );

	QSettings settings;

	settingsVersion = settings.value( "Settings/Version" );
	if ( settingsVersion.isNull() ) {
		// First time install, save defaults to registry
		save();
		settings.setValue( "Settings/Version", 1.0 );
	}

	connect( ui->categoryList, &QListWidget::currentItemChanged, this, &SettingsDialog::changePage );
	connect( ui->submit, &QDialogButtonBox::accepted, this, &SettingsDialog::save );
	connect( ui->submit, &QDialogButtonBox::clicked, [this]( QAbstractButton * btn ) {
		if ( btn == btnApply )
			apply();
	} );
	connect( ui->submit, &QDialogButtonBox::rejected, this, &SettingsDialog::cancel );
	connect( ui->restoreAllDefaults, &QPushButton::clicked, this, &SettingsDialog::restoreDefaults );
}

SettingsDialog::~SettingsDialog()
{
}


void SettingsDialog::registerPage( QWidget * parent, const QString & text )
{
	auto p = qobject_cast<SettingsDialog *>(parent);
	if ( p )
		p->categories->addItem( text );
}

bool SettingsDialog::apply()
{
	// A configuration write failure must leave Save/Apply available and the dialog open.
	if ( !sanitizePane->saveChanges() )
		return false;
	emit saveSettings();
	emit update3D();

	btnSave->setEnabled( false );
	btnApply->setEnabled( false );
	btnCancel->setText( tr("Close") );
	return true;
}

void SettingsDialog::save()
{
	if ( apply() )
		close();
}

void SettingsDialog::cancel()
{
	emit loadSettings();

	close();

	btnSave->setEnabled( false );
	btnApply->setEnabled( false );
	btnCancel->setText( tr("Close") );
}

void SettingsDialog::restoreDefaults()
{
	auto tmpDlg = std::unique_ptr<SettingsDialog>( new SettingsDialog );
	tmpDlg->sanitizePane->setDefault();
	if ( !tmpDlg->apply() )
		return;

	loadSettings();
}

void SettingsDialog::modified()
{
	btnSave->setEnabled( true );
	btnApply->setEnabled( true );
	btnCancel->setText( tr("Cancel") );
}

void SettingsDialog::changePage( QListWidgetItem * current, QListWidgetItem * previous )
{
	if ( !current )
		current = previous;

	content->setCurrentIndex( categories->row( current ) );
}

bool SettingsDialog::eventFilter( QObject * o, QEvent * e )
{
	return QDialog::eventFilter( o, e );
}

void SettingsDialog::showEvent( QShowEvent * e )
{
	emit loadSettings();

	QDialog::showEvent( e );
}
