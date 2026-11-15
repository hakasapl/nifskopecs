#version 410 core

/*
 * Community Shaders TruePBR (Skyrim and SSE, Shader Flags 2 bit 23, see build/NIF-CS.xml)
 *
 * Copyright (C) the Community Shaders contributors, https://github.com/community-shaders/skyrim-community-shaders
 * Modified in November 2026 for NifSkopeCS: ported from HLSL to GLSL, as described below.
 *
 * Unlike the rest of NifSkope, this file is licensed under version 3 of the GNU General Public License (see
 * LICENSE-GPL-3.0.txt), as the Community Shaders code it is a port of. It is distributed WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * Port of the TRUE_PBR path of the Community Shaders lighting shader, with its default settings
 * (Linear Lighting and Extended Materials parallax enabled, micro shadows on, vertex AO strength 1):
 *   package/Shaders/Lighting.hlsl          material setup and composition
 *   package/Shaders/Common/PBR.hlsli       direct and indirect lighting (GetDirectLightInput, GetIndirectLobeWeights)
 *   package/Shaders/Common/PBRMath.hlsli   fuzz, thin surface and hair helpers
 *   package/Shaders/Common/BRDF.hlsli      D_GGX, Vis_SmithJoint(Approx), F_Schlick, EnvBRDFApproxLazarov
 *   package/Shaders/Common/Shading.hlsli   MultiBounceAO, SpecularOcclusion, ApproximateDirectOcculusion
 *   features/Extended Materials/.../ExtendedMaterialsParallaxCore.hlsli   parallax and its soft shadow
 *   package/Shaders/Common/Glints/Glints2023.hlsli and noisegen.cs.hlsl   glints (noise texture computed on the fly)
 * The function names follow the original ones. The game lighting is replaced by the NifSkope light, and the ambient
 * lighting and reflections by the pre-filtered cube map (diffuse and specular), as for Fallout 76.
 * Not ported, as they do not come from the NIF: projected materials (MATO), wetness, skylighting, TXST JSON configs.
 */

#include "uniforms.glsl"

uniform sampler2D BaseMap;
uniform sampler2D NormalMap;
uniform sampler2D EmissiveMap;		// texture 2
uniform sampler2D DisplacementMap;	// texture 3: displacement in R, fuzz roughness in G
uniform sampler2D RMAOSMap;			// texture 5: roughness, metallic, AO, specular level
uniform sampler2D FeatureMap1;		// texture 6: fuzz (color, weight) or coat normal (normal, roughness)
uniform sampler2D FeatureMap0;		// texture 7: subsurface (color, thickness) or coat (color, strength)
uniform samplerCube CubeMap;		// pre-filtered specular environment
uniform samplerCube CubeMap2;		// diffuse environment

uniform int pbrFlags;				// PBR::Flags
uniform vec4 pbrParams1;			// roughness scale, displacement scale, specular level
uniform vec4 pbrParams2;			// subsurface color and opacity, or coat color and strength
uniform vec4 layerParams;			// coat roughness and specular level, fuzz color and weight, or glint parameters
uniform float fuzzRoughness;		// negative: use the base roughness
uniform vec4 thinSurfaceParams;		// subsurface balance, front / back specular weights, back roughness scale
uniform bool treeAnim;				// TREE_ANIM technique (Shader Flags 2 Tree_Anim)

uniform vec3 emissiveColor;			// emissive color (sRGB), black without Own_Emit
uniform float emissiveMult;
uniform bool hasSpecular;
uniform bool hasCubeMap;

uniform float alpha;
uniform int alphaFlags;				// bits 0 to 2: alpha test mode, bit 3: alpha blending enabled
uniform float alphaThreshold;

uniform vec2 uvScale;
uniform vec2 uvOffset;

in vec3 LightDir;
in vec3 ViewDir;
in vec3 ViewPos;

in vec2 texCoord;

in vec4 C;

in mat3 btnMatrix;
flat in mat3 reflMatrix;

out vec4 fragColor;

// PBR::Flags
#define FLAG_HAS_EMISSIVE				0x0001
#define FLAG_HAS_DISPLACEMENT			0x0002
#define FLAG_HAS_FEATURE_TEXTURE0		0x0004
#define FLAG_HAS_FEATURE_TEXTURE1		0x0008
#define FLAG_SUBSURFACE					0x0010
#define FLAG_TWO_LAYER					0x0020
#define FLAG_COLORED_COAT				0x0040
#define FLAG_INTERLAYER_PARALLAX		0x0080
#define FLAG_COAT_NORMAL				0x0100
#define FLAG_FUZZ						0x0200
#define FLAG_HAIR_MARSCHNER				0x0400
#define FLAG_GLINT						0x0800
#define FLAG_FOLIAGE					0x2000
#define FLAG_THIN_SURFACE				0x4000
#define FLAG_HAS_FUZZ_ROUGHNESS_TEXTURE	0x8000

const float PI = 3.14159265358979323846;
const float TAU = 6.28318530717958647692;
const float INV_PI = 0.31830988618379067154;
const float EPSILON_DOT_CLAMP = 1e-5;
const float EPSILON_DIVISION = 1e-6;
const float MIN_ROUGHNESS = 0.04;
const float MAX_ROUGHNESS = 1.0;
const float GLOWMAP_MULT = 0.66;			// Linear Lighting glowmapMult
const float MICRO_SHADOW_STRENGTH = 1.0;	// TruePBR micro shadows

bool hasFlag( int f )
{
	return ( pbrFlags & f ) != 0;
}

float saturate( float x )
{
	return clamp( x, 0.0, 1.0 );
}

vec3 saturate( vec3 x )
{
	return clamp( x, 0.0, 1.0 );
}

vec3 srgbToLinear( vec3 c )
{
	c = max( c, vec3( 0.0 ) );
	return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
}

vec3 linearToSrgb( vec3 c )
{
	c = max( c, vec3( 0.0 ) );
	return mix( c * 12.92, pow( c, vec3( 1.0 / 2.4 ) ) * 1.055 - 0.055, step( vec3( 0.0031308 ), c ) );
}

// ---------------------------------------------------------------------------------------------------------------
// BRDF.hlsli

float D_GGX( float roughness, float NdotH )
{
	float NdotH2 = NdotH * NdotH;
	float a = roughness * roughness;
	float a2 = a * a;
	float d = NdotH2 * ( a2 - 1.0 ) + 1.0;
	return a2 / ( PI * d * d );
}

float Vis_SmithJointApprox( float roughness, float NdotV, float NdotL )
{
	float a = roughness * roughness;
	float Vis_SmithV = NdotL * ( NdotV * ( 1.0 - a ) + a );
	float Vis_SmithL = NdotV * ( NdotL * ( 1.0 - a ) + a );
	return 0.5 / max( Vis_SmithV + Vis_SmithL, EPSILON_DIVISION );
}

float Vis_SmithJoint( float roughness, float NdotV, float NdotL )
{
	float a = roughness * roughness;
	float a2 = a * a;
	float Vis_SmithV = NdotL * sqrt( a2 + ( 1.0 - a2 ) * NdotV * NdotV );
	float Vis_SmithL = NdotV * sqrt( a2 + ( 1.0 - a2 ) * NdotL * NdotL );
	return 0.5 / max( Vis_SmithV + Vis_SmithL, EPSILON_DIVISION );
}

vec3 F_Schlick( vec3 F0, float VdotH )
{
	float Fc = pow( 1.0 - VdotH, 5.0 );
	return vec3( Fc ) + ( 1.0 - Fc ) * F0;
}

float Diffuse_Lambert()
{
	return INV_PI;
}

// [Lazarov 2013, "Getting More Physical in Call of Duty: Black Ops II"]
vec2 EnvBRDF( float roughness, float NdotV )
{
	const vec4 c0 = vec4( -1.0, -0.0275, -0.572, 0.022 );
	const vec4 c1 = vec4( 1.0, 0.0425, 1.04, -0.04 );
	vec4 r = roughness * c0 + c1;
	float a004 = min( r.x * r.x, exp2( -9.28 * NdotV ) ) * r.x + r.y;
	return vec2( -1.04, 1.04 ) * a004 + r.zw;
}

// ---------------------------------------------------------------------------------------------------------------
// Shading.hlsli

vec3 MultiBounceAO( vec3 baseColor, float ao )
{
	vec3 a = 2.0404 * baseColor - 0.3324;
	vec3 b = -4.7951 * baseColor + 0.6417;
	vec3 c = 2.7552 * baseColor + 0.6903;
	return max( vec3( ao ), ( ( ao * a + b ) * ao + c ) * ao );
}

float SpecularOcclusion( float NdotV, float alpha_, float occlusion )
{
	return saturate( pow( abs( NdotV + occlusion ), alpha_ ) - 1.0 + occlusion );
}

float ApproximateDirectOcculusion( float aoVisibility, float NdotL )
{
	float aperture = inversesqrt( 1.0000001 - aoVisibility );
	NdotL += 0.1;
	return saturate( NdotL * aperture );
}

// ---------------------------------------------------------------------------------------------------------------
// PBRMath.hlsli

struct MaterialProperties
{
	vec3 BaseColor;
	float Roughness;
	float Metallic;
	float AO;
	vec3 F0;
	vec3 SubsurfaceColor;
	float Thickness;
	float SubsurfaceBalance;
	float ThinSurfaceSpecularWeight;
	vec3 CoatColor;
	float CoatStrength;
	float CoatRoughness;
	vec3 CoatF0;
	vec3 FuzzColor;
	float FuzzWeight;
	float FuzzRoughness;
};

struct FuzzLTC
{
	vec3 X;
	vec3 Y;
	vec3 N;
	float aInv;
	float bInv;
};

struct FuzzLayer
{
	float weight;
	vec3 color;
	float roughness;
	float weightedAlbedo;
	float specularThroughput;
	FuzzLTC ltc;
};

bool IsFoliageMaterial()
{
	if ( treeAnim )
		return hasFlag( FLAG_FOLIAGE | FLAG_SUBSURFACE );
	return hasFlag( FLAG_FOLIAGE );
}

bool IsThinSurfaceMaterial()
{
	return IsFoliageMaterial() || hasFlag( FLAG_THIN_SURFACE );
}

vec3 SpecularMicrofacet( float roughness, vec3 F0, float NdotL, float NdotV, float NdotH, float VdotH, out vec3 F )
{
	float D = D_GGX( roughness, NdotH );
	float G = Vis_SmithJointApprox( roughness, NdotV, NdotL );
	F = F_Schlick( F0, VdotH );
	return D * G * F;
}

vec3 SpecularDirectionalAlbedo( vec3 F0, float roughness, float NdotV )
{
	vec2 specularBRDF = EnvBRDF( roughness, NdotV );
	return F0 * specularBRDF.x + specularBRDF.y;
}

vec3 GetThinSurfaceNormal( vec3 N, vec3 V )
{
	return dot( N, V ) < 0.0 ? -N : N;
}

vec3 GetThinSurfaceFaceNormal( vec3 position, vec3 V, vec3 fallbackNormal )
{
	vec3 faceNormal = cross( dFdx( position ), dFdy( position ) );
	float lengthSq = dot( faceNormal, faceNormal );
	faceNormal = lengthSq > 1e-12 ? faceNormal * inversesqrt( lengthSq ) : fallbackNormal;
	return GetThinSurfaceNormal( faceNormal, V );
}

// With Linear Lighting, PBR material colors are linear: Color::PBRMaterialToLinear and LinearToPBRMaterial are no-ops
void GetThinSurfaceSubsurfaceAlbedos( vec3 baseColor, vec3 scatteringColor, float opacity, float balance,
	out float reflectionWeight, out vec3 frontTransmissionAlbedo, out vec3 backTransmissionAlbedo )
{
	float subsurfaceShare = 1.0 - saturate( opacity );
	float backShare = saturate( balance );
	vec3 weights = vec3( subsurfaceShare * ( 1.0 - backShare ), subsurfaceShare * backShare, 1.0 - subsurfaceShare );
	vec3 litFaceAlbedo = weights.z * baseColor + weights.x * scatteringColor;
	reflectionWeight = weights.z;
	frontTransmissionAlbedo = saturate( litFaceAlbedo - baseColor * weights.z );
	backTransmissionAlbedo = saturate( scatteringColor * weights.y );
}

float GetThinSurfaceBackTransmissionVisibility( vec3 faceNormal, vec3 L )
{
	return 1.0 - saturate( 4.0 * dot( faceNormal, L ) );
}

vec2 GetThinSurfaceDiffuseCosines( float NdotL, float wrap )
{
	float normalization = 1.0 / ( ( 1.0 + wrap ) * ( 1.0 + wrap ) );
	return vec2( saturate( ( NdotL + wrap ) * normalization ), saturate( ( wrap - NdotL ) * normalization ) );
}

void GetThinSurfaceDirectScattering( vec3 reflectionAlbedo, vec3 frontTransmissionAlbedo, vec3 backTransmissionAlbedo,
	vec3 shineThroughAlbedo, float opacity, vec3 irradiance, float NdotL, float wrap, float reflectionShadow, vec2 transmissionShadows,
	out vec3 reflection, out vec3 transmission )
{
	vec3 transmittance = vec3( 1.0 - saturate( opacity ) );
	vec3 transmissionAlbedo = saturate( shineThroughAlbedo * transmittance + backTransmissionAlbedo );
	vec2 diffuseCosines = GetThinSurfaceDiffuseCosines( NdotL, wrap );
	reflection = reflectionAlbedo * diffuseCosines.x * irradiance * reflectionShadow;
	transmission = transmissionAlbedo * diffuseCosines.y * irradiance * transmissionShadows.y;
	transmission += frontTransmissionAlbedo * saturate( NdotL ) * irradiance * transmissionShadows.x;
}

float FilterFoliageRoughness( float roughness, vec3 normalDx, vec3 normalDy )
{
	float variance = 0.25 * ( dot( normalDx, normalDx ) + dot( normalDy, normalDy ) );
	float kernelRoughnessSq = min( 2.0 * variance, 0.18 );
	float roughnessSq = roughness * roughness;
	return sqrt( sqrt( saturate( roughnessSq * roughnessSq + kernelRoughnessSq ) ) );
}

float FuzzDirectionalAlbedo( float NdotV, float roughness )
{
	float s = roughness * ( 0.0206607 + 1.58491 * roughness ) / ( 0.0379424 + roughness * ( 1.32227 + roughness ) );
	float m = roughness * ( -0.193854 + roughness * ( -1.14885 + roughness * ( 1.7932 - 0.95943 * roughness * roughness ) ) ) / ( 0.046391 + roughness );
	float o = roughness * ( 0.000654023 + ( -0.0207818 + 0.119681 * roughness ) * roughness ) / ( 1.26264 + roughness * ( -1.92021 + roughness ) );
	float d = ( NdotV - m ) / s;
	return exp( -0.5 * d * d ) / ( s * sqrt( TAU ) ) + o;
}

FuzzLTC CreateFuzzLTC( vec3 V, vec3 N, float NdotV, float roughness )
{
	FuzzLTC ltc;
	ltc.X = V - N * NdotV;
	float lengthSquared = dot( ltc.X, ltc.X );
	ltc.X = lengthSquared > 1e-8 ? ltc.X * inversesqrt( lengthSquared ) : normalize( abs( N.z ) < 0.999 ? cross( vec3( 0.0, 0.0, 1.0 ), N ) : vec3( 1.0, 0.0, 0.0 ) );
	ltc.Y = cross( N, ltc.X );
	ltc.N = N;
	ltc.aInv = ( 2.58126 * NdotV + 0.813703 * roughness ) * roughness / ( 1.0 + 0.310327 * NdotV * NdotV + 2.60994 * NdotV * roughness );
	ltc.bInv = sqrt( 1.0 - NdotV ) * ( roughness - 1.0 ) * roughness * roughness * roughness /
	           ( 0.0000254053 + 1.71228 * NdotV - 1.71506 * NdotV * roughness + 1.34174 * roughness * roughness );
	return ltc;
}

float FuzzLobe( vec3 L, FuzzLTC ltc )
{
	vec3 w = vec3( dot( L, ltc.X ), dot( L, ltc.Y ), dot( L, ltc.N ) );
	vec3 wo = vec3( ltc.aInv * w.x + ltc.bInv * w.z, ltc.aInv * w.y, w.z );
	float scale = ltc.aInv / dot( wo, wo );
	return max( wo.z, 0.0 ) * INV_PI * scale * scale;
}

float FuzzLobeTransmitted( vec3 L, FuzzLTC ltc )
{
	return FuzzLobe( reflect( L, ltc.N ), ltc );
}

float HairIOR()
{
	const float n = 1.55;
	const float a = 1.0;
	float ior1 = 2.0 * ( n - 1.0 ) * ( a * a ) - n + 2.0;
	float ior2 = 2.0 * ( n - 1.0 ) / ( a * a ) - n + 2.0;
	return 0.5 * ( ( ior1 + ior2 ) + 0.5 * ( ior1 - ior2 ) );
}

float IORToF0( float IOR )
{
	return pow( ( 1.0 - IOR ) / ( 1.0 + IOR ), 2.0 );
}

float HairGaussian( float B, float Theta )
{
	float B_safe = max( B, EPSILON_DIVISION );
	return exp( -0.5 * Theta * Theta / ( B_safe * B_safe ) ) / ( sqrt( TAU ) * B_safe );
}

// ---------------------------------------------------------------------------------------------------------------
// Random.hlsli

uvec2 pcg2d( uvec2 v )
{
	v = v * 1664525u + 1013904223u;
	v.x += v.y * 1664525u;
	v.y += v.x * 1664525u;
	v = v ^ ( v >> 16u );
	v.x += v.y * 1664525u;
	v.y += v.x * 1664525u;
	v = v ^ ( v >> 16u );
	return v;
}

uvec3 pcg3d( uvec3 v )
{
	v = v * 1664525u + 1013904223u;
	v.x += v.y * v.z;
	v.y += v.z * v.x;
	v.z += v.x * v.y;
	v ^= v >> 16u;
	v.x += v.y * v.z;
	v.y += v.z * v.x;
	v.z += v.x * v.y;
	return v;
}

// ---------------------------------------------------------------------------------------------------------------
// Glints2023.hlsli [Deliot and Belcour 2023, "Real-Time Rendering of Glinty Appearances using Distributed
// Binomial Laws on Anisotropic Grids"]

const float EPSILON_GLINTS = 1e-8;
const float HALF_PI = 1.57079632679489661923;

struct GlintCachedVars
{
	vec2 uv;
	uint gridSeed;
	float footprintArea;
};

// Glint parameters of the material, set in main()
bool glintEnabled = false;
float glintLogMicrofacetDensity = 0.0;
float glintMicrofacetRoughness = 0.0;
float glintDensityRandomization = 0.0;
float materialNoise = 0.0;
GlintCachedVars glintCache = GlintCachedVars( vec2( 0.0 ), 0u, 0.0 );

float erfinv( float x )
{
	float w, p;
	w = -log( ( 1.0 - x ) * ( 1.0 + x ) );
	if ( w < 5.0 ) {
		w = w - 2.5;
		p = 2.81022636e-08;
		p = 3.43273939e-07 + p * w;
		p = -3.5233877e-06 + p * w;
		p = -4.39150654e-06 + p * w;
		p = 0.00021858087 + p * w;
		p = -0.00125372503 + p * w;
		p = -0.00417768164 + p * w;
		p = 0.246640727 + p * w;
		p = 1.50140941 + p * w;
	} else {
		w = sqrt( w ) - 3.0;
		p = -0.000200214257;
		p = 0.000100950558 + p * w;
		p = 0.00134934322 + p * w;
		p = -0.00367342844 + p * w;
		p = 0.00573950773 + p * w;
		p = -0.0076224613 + p * w;
		p = 0.00943887047 + p * w;
		p = 1.00167406 + p * w;
		p = 2.83297682 + p * w;
	}
	return p * x;
}

float sampleNormalDistribution( float u, float mu, float sigma )
{
	return sigma * 1.414213 * erfinv( 2.0 * u - 1.0 ) + mu;
}

float HashWithoutSine13( vec3 p3 )
{
	p3 = fract( p3 * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

void GetGradientEllipse( vec2 duvdx, vec2 duvdy, out vec2 ellipseMajor, out vec2 ellipseMinor )
{
	// J = inverse( rows duvdx, duvdy ), then J * transpose( J )
	float det = duvdx.x * duvdy.y - duvdx.y * duvdy.x;
	vec2 r0 = vec2( duvdy.y, -duvdx.y ) / det;
	vec2 r1 = vec2( -duvdy.x, duvdx.x ) / det;

	float a = dot( r0, r0 );
	float b = dot( r0, r1 );
	float c = b;
	float d = dot( r1, r1 );

	float T = a + d;
	float D = a * d - b * c;
	float SQ = sqrt( abs( T * T / 3.99999 - D ) );
	float L1 = T / 2.0 - SQ;
	float L2 = T / 2.0 + SQ;

	vec2 A0 = vec2( L1 - d, c );
	vec2 A1 = vec2( L2 - d, c );
	ellipseMajor = normalize( A0 ) * inversesqrt( L1 );
	ellipseMinor = normalize( A1 ) * inversesqrt( L2 );
}

vec2 RotateUV( vec2 uv, float rotation, vec2 mid )
{
	vec2 rel_uv = uv - mid;
	float s = sin( rotation );
	float c = cos( rotation );
	return vec2( c * rel_uv.x + s * rel_uv.y + mid.x, c * rel_uv.y - s * rel_uv.x + mid.y );
}

float BilinearLerp( vec4 values, vec2 valuesLerp )
{
	// Values XY = vec4( 00, 01, 10, 11 )
	float resultX = mix( values.x, values.z, valuesLerp.x );
	float resultY = mix( values.y, values.w, valuesLerp.x );
	return mix( resultX, resultY, valuesLerp.y );
}

float Remap( float s, float a1, float a2, float b1, float b2 )
{
	return b1 + ( s - a1 ) * ( b2 - b1 ) / ( a2 - a1 );
}

float Remap01To( float s, float b1, float b2 )
{
	return b1 + s * ( b2 - b1 );
}

float RemapTo01( float s, float a1, float a2 )
{
	return ( s - a1 ) / ( a2 - a1 );
}

vec4 RemapTo01( vec4 s, vec4 a1, vec4 a2 )
{
	return ( s - a1 ) / ( a2 - a1 );
}

vec4 GetBarycentricWeightsTetrahedron( vec3 p, vec3 v1, vec3 v2, vec3 v3, vec3 v4 )
{
	vec3 c11 = v1 - v4, c21 = v2 - v4, c31 = v3 - v4, c41 = v4 - p;

	vec2 m1 = c31.yz / c31.x;
	vec2 c12 = c11.yz - c11.x * m1, c22 = c21.yz - c21.x * m1, c32 = c41.yz - c41.x * m1;

	vec4 uvwk = vec4( 0.0 );
	float m2 = c22.y / c22.x;
	uvwk.x = ( c32.x * m2 - c32.y ) / ( c12.y - c12.x * m2 );
	uvwk.y = -( c32.x + c12.x * uvwk.x ) / c22.x;
	uvwk.z = -( c41.x + c21.x * uvwk.y + c11.x * uvwk.x ) / c31.x;
	uvwk.w = 1.0 - uvwk.z - uvwk.y - uvwk.x;

	return uvwk;
}

// noisegen.cs.hlsl: the 128x128 noise texture, one texel per call
uint WangHash( uint seed )
{
	seed = ( seed ^ 61u ) ^ ( seed >> 16u );
	seed *= 9u;
	seed = seed ^ ( seed >> 4u );
	seed *= 0x27d4eb2du;
	seed = seed ^ ( seed >> 15u );
	return seed;
}

float RandXorshiftFloat( inout uint rngState )
{
	rngState ^= ( rngState << 13u );
	rngState ^= ( rngState >> 17u );
	rngState ^= ( rngState << 5u );
	return float( rngState ) * ( 1.0 / 4294967296.0 );
}

void GlintNoiseCell( uvec2 coord, out float u, out float g )
{
	const uint size = 128u;
	uvec2 c = coord * 123u;
	uint rngState = WangHash( c.y * size + c.x + size * size * 0x69420u );
	u = RandXorshiftFloat( rngState );
	g = sqrt( 2.0 ) * erfinv( 2.0 * RandXorshiftFloat( rngState ) - 1.0 );
}

void CustomRand4Texture( float microfacetRoughness, vec2 slope, vec2 slopeRandOffset, out vec4 outUniform, out vec4 outGaussian, out vec2 slopeLerp )
{
	const uint size = 128u;
	vec2 slope2 = abs( slope ) / microfacetRoughness;
	slope2 = slope2 + ( slopeRandOffset * float( size ) );
	slopeLerp = fract( slope2 );
	uvec2 slopeCoord = uvec2( floor( slope2 ) ) % size;

	// Random numbers of this cell and of the next ones in X and Y
	GlintNoiseCell( slopeCoord, outUniform.x, outGaussian.x );
	GlintNoiseCell( ( slopeCoord + uvec2( 0u, 1u ) ) % size, outUniform.y, outGaussian.y );
	GlintNoiseCell( ( slopeCoord + uvec2( 1u, 0u ) ) % size, outUniform.z, outGaussian.z );
	GlintNoiseCell( ( slopeCoord + uvec2( 1u, 1u ) ) % size, outUniform.w, outGaussian.w );
}

float GenerateAngularBinomialValueForSurfaceCell( vec4 randB, vec4 randG, vec2 slopeLerp, float footprintOneHitProba, float binomialSmoothWidth, float footprintMean, float footprintSTD, float microfacetCount )
{
	vec4 gating;
	if ( binomialSmoothWidth > 0.0000001 )
		gating = clamp( RemapTo01( randB, vec4( footprintOneHitProba + binomialSmoothWidth ), vec4( footprintOneHitProba - binomialSmoothWidth ) ), 0.0, 1.0 );
	else
		gating = vec4( lessThan( randB, vec4( footprintOneHitProba ) ) );

	vec4 gauss = randG * footprintSTD + footprintMean;
	gauss = clamp( floor( gauss ), 0.0, microfacetCount );
	vec4 results = gating * ( 1.0 + gauss );
	return BilinearLerp( results, slopeLerp );
}

float SampleGlintGridSimplex( float noise, float logDensity, float roughness, float densityRandomization, GlintCachedVars vars, vec2 slope, float targetNDF )
{
	// Get surface space glint simplex grid cell
	vec2 skewedCoord = vec2( vars.uv.x - 0.57735027 * vars.uv.y, 1.15470054 * vars.uv.y );
	ivec2 baseId = ivec2( floor( skewedCoord ) );
	vec3 temp = vec3( fract( skewedCoord ), 0.0 );
	temp.z = 1.0 - temp.x - temp.y;
	float s = step( 0.0, -temp.z );
	float s2 = 2.0 * s - 1.0;
	ivec2 glint0 = baseId + ivec2( int( s ), int( s ) );
	ivec2 glint1 = baseId + ivec2( int( s ), int( 1.0 - s ) );
	ivec2 glint2 = baseId + ivec2( int( 1.0 - s ), int( s ) );
	vec3 barycentrics = vec3( -temp.z * s2, s - temp.y * s2, s - temp.x * s2 );

	// Generate per surface cell random number to pick sample
	vec2 accumWeights = barycentrics.xy;
	accumWeights.y += accumWeights.x;
	int selectedSample = 2;
	if ( noise < accumWeights.x )
		selectedSample = 0;
	else if ( noise < accumWeights.y )
		selectedSample = 1;

	ivec2 selectedGlint = ( selectedSample == 0 ) ? glint0 : ( ( selectedSample == 1 ) ? glint1 : glint2 );
	vec3 randSelected = vec3( pcg3d( uvec3( uvec2( selectedGlint ) + 2147483648u, vars.gridSeed ) ) ) / 4294967296.0;

	// Get per surface cell per slope cell random numbers
	vec4 randSlopesB, randSlopesG;
	vec2 slopeLerp;
	CustomRand4Texture( roughness, slope, randSelected.yz, randSlopesB, randSlopesG, slopeLerp );

	// Compute microfacet count with randomization
	float logDensityRand = clamp( sampleNormalDistribution( randSelected.x, logDensity, densityRandomization ), 0.0, 50.0 );
	float microfacetCount = max( 1e-8, vars.footprintArea * exp( logDensityRand ) );

	// Compute binomial properties
	float hitProba = roughness * targetNDF;
	float footprintOneHitProba = ( 1.0 - pow( abs( 1.0 - hitProba ), microfacetCount ) );
	float footprintMean = ( microfacetCount - 1.0 ) * hitProba;
	float footprintSTD = sqrt( max( ( microfacetCount - 1.0 ) * hitProba * ( 1.0 - hitProba ), 0.0 ) );
	float binomialSmoothWidth = 0.1 * clamp( footprintOneHitProba * 10.0, 0.0, 1.0 ) * clamp( ( 1.0 - footprintOneHitProba ) * 10.0, 0.0, 1.0 );

	// Generate numbers of reflecting microfacets
	float result = GenerateAngularBinomialValueForSurfaceCell( randSlopesB, randSlopesG, slopeLerp, footprintOneHitProba, binomialSmoothWidth, footprintMean, footprintSTD, microfacetCount );
	return result / microfacetCount;
}

void GetAnisoCorrectingGridTetrahedron( bool centerSpecialCase, inout float thetaBinLerp, float ratioLerp, float lodLerp, out vec3 p0, out vec3 p1, out vec3 p2, out vec3 p3 )
{
	if ( centerSpecialCase ) {
		// SPECIAL CASE (no anisotropy, center of blending pattern, different triangulation)
		vec3 a = vec3( 0, 1, 0 );
		vec3 b = vec3( 0, 0, 0 );
		vec3 c = vec3( 1, 1, 0 );
		vec3 d = vec3( 0, 1, 1 );
		vec3 e = vec3( 0, 0, 1 );
		vec3 f = vec3( 1, 1, 1 );
		if ( lodLerp > 1.0 - ratioLerp ) {
			// Upper pyramid
			if ( RemapTo01( lodLerp, 1.0 - ratioLerp, 1.0 ) > thetaBinLerp ) {
				p0 = a; p1 = e; p2 = d; p3 = f;	// Left-up tetrahedron (a, e, d, f)
			} else {
				p0 = f; p1 = e; p2 = c; p3 = a;	// Right-down tetrahedron (f, e, c, a)
			}
		} else {
			p0 = b; p1 = a; p2 = c; p3 = e;	// Lower tetrahedron (b, a, c, e)
		}
	} else {
		// NORMAL CASE
		vec3 a = vec3( 0, 1, 0 );
		vec3 b = vec3( 0, 0, 0 );
		vec3 c = vec3( 0.5, 1, 0 );
		vec3 d = vec3( 1, 0, 0 );
		vec3 e = vec3( 1, 1, 0 );
		vec3 f = vec3( 0, 1, 1 );
		vec3 g = vec3( 0, 0, 1 );
		vec3 h = vec3( 0.5, 1, 1 );
		vec3 i = vec3( 1, 0, 1 );
		vec3 j = vec3( 1, 1, 1 );
		if ( thetaBinLerp < 0.5 && thetaBinLerp * 2.0 < ratioLerp ) {
			// Prism A
			if ( lodLerp > 1.0 - ratioLerp ) {
				// Upper pyramid
				if ( RemapTo01( lodLerp, 1.0 - ratioLerp, 1.0 ) > RemapTo01( thetaBinLerp * 2.0, 0.0, ratioLerp ) ) {
					p0 = a; p1 = f; p2 = h; p3 = g;	// Left-up tetrahedron (a, f, h, g)
				} else {
					p0 = c; p1 = a; p2 = h; p3 = g;	// Right-down tetrahedron (c, a, h, g)
				}
			} else {
				p0 = b; p1 = a; p2 = c; p3 = g;	// Lower tetrahedron (b, a, c, g)
			}
		} else if ( 1.0 - ( ( thetaBinLerp - 0.5 ) * 2.0 ) > ratioLerp ) {
			// Prism B
			if ( lodLerp < 1.0 - ratioLerp ) {
				// Lower pyramid
				if ( RemapTo01( lodLerp, 0.0, 1.0 - ratioLerp ) > RemapTo01( thetaBinLerp, 0.5 - ( 1.0 - ratioLerp ) * 0.5, 0.5 + ( 1.0 - ratioLerp ) * 0.5 ) ) {
					p0 = b; p1 = g; p2 = i; p3 = c;	// Left-up tetrahedron (b, g, i, c)
				} else {
					p0 = d; p1 = b; p2 = c; p3 = i;	// Right-down tetrahedron (d, b, c, i)
				}
			} else {
				p0 = c; p1 = g; p2 = h; p3 = i;	// Upper tetrahedron (c, g, h, i)
			}
		} else {
			// Prism C
			if ( lodLerp > 1.0 - ratioLerp ) {
				// Upper pyramid
				if ( RemapTo01( lodLerp, 1.0 - ratioLerp, 1.0 ) > RemapTo01( ( thetaBinLerp - 0.5 ) * 2.0, 1.0 - ratioLerp, 1.0 ) ) {
					p0 = c; p1 = j; p2 = h; p3 = i;	// Left-up tetrahedron (c, j, h, i)
				} else {
					p0 = e; p1 = i; p2 = c; p3 = j;	// Right-down tetrahedron (e, i, c, j)
				}
			} else {
				p0 = d; p1 = e; p2 = c; p3 = i;	// Lower tetrahedron (d, e, c, i)
			}
		}
	}
}

void PrecomputeGlints( float rnd, vec2 uv, vec2 duvdx, vec2 duvdy, float screenSpaceScale, out GlintCachedVars vars )
{
	// ACCURATE PIXEL FOOTPRINT ELLIPSE
	vec2 ellipseMajor, ellipseMinor;
	GetGradientEllipse( duvdx, duvdy, ellipseMajor, ellipseMinor );
	float ellipseRatio = length( ellipseMajor ) / ( length( ellipseMinor ) + EPSILON_GLINTS );

	// SHARED GLINT NDF VALUES
	float halfScreenSpaceScaler = screenSpaceScale * 0.5;
	float footprintArea = length( ellipseMajor ) * halfScreenSpaceScaler * length( ellipseMinor ) * halfScreenSpaceScaler * 4.0;

	// MANUAL LOD COMPENSATION
	float lod = log2( length( ellipseMinor ) * halfScreenSpaceScaler );
	float lod0 = float( int( lod ) );
	float lod1 = lod0 + 1.0;
	float divLod0 = pow( 2.0, lod0 );
	float divLod1 = pow( 2.0, lod1 );
	float lodLerp = fract( lod );
	float footprintAreaLOD0 = exp2( 2.0 * lod0 );
	float footprintAreaLOD1 = exp2( 2.0 * lod1 );

	// MANUAL ANISOTROPY RATIO COMPENSATION
	float ratio0 = max( pow( 2.0, float( int( log2( ellipseRatio ) ) ) ), 1.0 );
	float ratio1 = ratio0 * 2.0;
	float ratioLerp = saturate( Remap( ellipseRatio, ratio0, ratio1, 0.0, 1.0 ) );

	// MANUAL ANISOTROPY ROTATION COMPENSATION
	vec2 v1 = vec2( 0.0, 1.0 );
	vec2 v2 = normalize( ellipseMajor );
	float theta = atan( v1.x * v2.y - v1.y * v2.x, v1.x * v2.x + v1.y * v2.y );
	float thetaGrid = HALF_PI / max( ratio0, 2.0 );
	float thetaBin = float( int( theta / thetaGrid ) ) * thetaGrid;
	thetaBin = thetaBin + ( thetaGrid / 2.0 );
	float thetaBin0 = theta < thetaBin ? thetaBin - thetaGrid / 2.0 : thetaBin;
	float thetaBinH = thetaBin0 + thetaGrid / 4.0;
	float thetaBin1 = thetaBin0 + thetaGrid / 2.0;
	float thetaBinLerp = Remap( theta, thetaBin0, thetaBin1, 0.0, 1.0 );
	thetaBin0 = thetaBin0 <= 0.0 ? PI + thetaBin0 : thetaBin0;

	// TETRAHEDRONIZATION OF ROTATION + RATIO + LOD GRID
	bool centerSpecialCase = ( ratio0 == 1.0 );
	vec2 divLods = vec2( divLod0, divLod1 );
	vec2 footprintAreas = vec2( footprintAreaLOD0, footprintAreaLOD1 );
	vec2 ratios = vec2( ratio0, ratio1 );
	vec4 thetaBins = vec4( thetaBin0, thetaBinH, thetaBin1, 0.0 );	// added 0.0 for center singularity case
	vec3 tetras[4];
	GetAnisoCorrectingGridTetrahedron( centerSpecialCase, thetaBinLerp, ratioLerp, lodLerp, tetras[0], tetras[1], tetras[2], tetras[3] );
	if ( centerSpecialCase )	// Account for center singularity in barycentric computation
		thetaBinLerp = Remap01To( thetaBinLerp, 0.0, ratioLerp );
	vec4 tetraBarycentricWeights = GetBarycentricWeightsTetrahedron( vec3( thetaBinLerp, ratioLerp, lodLerp ), tetras[0], tetras[1], tetras[2], tetras[3] );

	vec3 accumWeights = normalize( tetraBarycentricWeights ).xyz;
	accumWeights.y += accumWeights.x;
	accumWeights.z += accumWeights.y;

	int selectedTetra = 3;
	if ( rnd < accumWeights.x )
		selectedTetra = 0;
	else if ( rnd < accumWeights.y )
		selectedTetra = 1;
	else if ( rnd < accumWeights.z )
		selectedTetra = 2;

	// PREPARE NEEDED ROTATIONS
	vec3 tetra = tetras[selectedTetra];
	tetra.x *= 2.0;
	if ( centerSpecialCase )
		tetra.x = ( tetra.y == 0.0 ) ? 3.0 : tetra.x;
	int tx = int( tetra.x );
	int ty = int( tetra.y );
	int tz = int( tetra.z );

	float thetaBinSel = thetaBins[tx];
	vars.uv = RotateUV( uv, thetaBinSel, vec2( 0.0 ) ) / divLods[tz] / vec2( 1.0, ratios[ty] );
	// HLSL fmod truncates toward zero
	float thetaMod = thetaBinSel - TAU * trunc( thetaBinSel / TAU );
	vars.gridSeed = uint( HashWithoutSine13( vec3( log2( divLods[tz] ), thetaMod, ratios[ty] ) ) * 4294967296.0 );
	vars.footprintArea = ratios[ty] * footprintAreas[tz];
}

float SampleGlints2023NDF( float noise, float logDensity, float roughness, float densityRandomization, GlintCachedVars vars, vec3 H, float targetNDF, float maxNDF )
{
	vec2 slope = H.xy;	// Orthographic slope projected grid
	float rescaledTargetNDF = targetNDF / maxNDF;
	float sampleContribution = SampleGlintGridSimplex( noise, logDensity, roughness, densityRandomization, vars, slope, rescaledTargetNDF );
	return min( sampleContribution * ( 1.0 / roughness ), 60.0 ) * maxNDF;	// somewhat brute force way of prevent glazing angle extremities
}

// GGX normal distribution, replaced by the glint NDF with Glint (glintH = half vector in tangent space)
float GlintAwareD_GGX( float roughness, float NdotH, vec3 glintH )
{
	float D = D_GGX( roughness, NdotH );
	if ( glintEnabled && glintLogMicrofacetDensity > 1.1 ) {
		float Dmax = D_GGX( roughness, 1.0 );
		D = SampleGlints2023NDF( materialNoise, glintLogMicrofacetDensity, glintMicrofacetRoughness, glintDensityRandomization, glintCache, glintH, D, Dmax );
	}
	return D;
}

// ---------------------------------------------------------------------------------------------------------------
// PBR.hlsli

// SpecularMicrofacetWithGlint
vec3 SpecularMicrofacetWithGlint( float roughness, vec3 F0, float NdotL, float NdotV, float NdotH, float VdotH, vec3 glintH, out vec3 F )
{
	float D = GlintAwareD_GGX( roughness, NdotH, glintH );
	float G = Vis_SmithJointApprox( roughness, NdotV, NdotL );
	F = F_Schlick( F0, VdotH );
	return D * G * F;
}

vec3 GetHairDiffuseColorMarschner( vec3 N, vec3 V, vec3 L, float NdotL, float NdotV, float VdotL, float backlit, float area, MaterialProperties material )
{
	vec3 S = vec3( 0.0 );

	float cosThetaL = sqrt( max( 0.0, 1.0 - NdotL * NdotL ) );
	float cosThetaV = sqrt( max( 0.0, 1.0 - NdotV * NdotV ) );
	float cosThetaD = sqrt( ( 1.0 + cosThetaL * cosThetaV + NdotV * NdotL ) / 2.0 );

	vec3 Lp = L - NdotL * N;
	vec3 Vp = V - NdotV * N;
	float cosPhi = dot( Lp, Vp ) * inversesqrt( dot( Lp, Lp ) * dot( Vp, Vp ) + EPSILON_DIVISION );
	float cosHalfPhi = sqrt( saturate( 0.5 + 0.5 * cosPhi ) );

	float n_prime = 1.19 / cosThetaD + 0.36 * cosThetaD;

	const float Shift = 0.0499;
	float Alpha[3] = float[3]( -Shift * 2.0, Shift, Shift * 4.0 );
	float B[3] = float[3]( area + material.Roughness, area + material.Roughness / 2.0, area + material.Roughness * 2.0 );

	float hairIOR = HairIOR();
	float F0 = IORToF0( hairIOR );

	vec3 Tp;
	float Mp, Np, Fp, a, h, f;
	float ThetaH = NdotL + NdotV;
	// R
	Mp = HairGaussian( B[0], ThetaH - Alpha[0] );
	Np = 0.25 * cosHalfPhi;
	Fp = F_Schlick( vec3( F0 ), sqrt( saturate( 0.5 + 0.5 * VdotL ) ) ).x;
	S += vec3( ( Mp * Np ) * ( Fp * mix( 1.0, backlit, saturate( -VdotL ) ) ) );

	// TT
	Mp = HairGaussian( B[1], ThetaH - Alpha[1] );
	a = ( 1.55 / hairIOR ) / n_prime;
	h = cosHalfPhi * ( 1.0 + a * ( 0.6 - 0.8 * cosPhi ) );
	f = F_Schlick( vec3( F0 ), cosThetaD * sqrt( saturate( 1.0 - h * h ) ) ).x;
	Fp = ( 1.0 - f ) * ( 1.0 - f );
	Tp = pow( abs( material.BaseColor ), vec3( 0.5 * sqrt( 1.0 - ( h * a ) * ( h * a ) ) / cosThetaD ) );
	Np = exp( -3.65 * cosPhi - 3.98 );
	S += ( Mp * Np ) * ( Fp * Tp ) * backlit;

	// TRT
	Mp = HairGaussian( B[2], ThetaH - Alpha[2] );
	f = F_Schlick( vec3( F0 ), cosThetaD * 0.5 ).x;
	Fp = ( 1.0 - f ) * ( 1.0 - f ) * f;
	Tp = pow( abs( material.BaseColor ), vec3( 0.8 / cosThetaD ) );
	Np = exp( 17.0 * cosPhi - 16.78 );
	S += ( Mp * Np ) * ( Fp * Tp );

	return S;
}

vec3 GetHairDiffuseAttenuationKajiyaKay( vec3 N, vec3 V, vec3 L, float NdotL, float NdotV, float shadow, MaterialProperties material )
{
	float diffuseKajiya = 1.0 - abs( NdotL );

	vec3 fakeN = normalize( V - N * NdotV );
	const float wrap = 1.0;
	float wrappedNdotL = saturate( ( dot( fakeN, L ) + wrap ) / ( ( 1.0 + wrap ) * ( 1.0 + wrap ) ) );
	float diffuseScatter = INV_PI * mix( wrappedNdotL, diffuseKajiya, 0.33 );
	float luma = dot( material.BaseColor, vec3( 0.2126, 0.7152, 0.0722 ) );
	vec3 scatterTint = pow( material.BaseColor / max( luma, 1e-5 ), vec3( 1.0 - shadow ) );
	return sqrt( material.BaseColor ) * diffuseScatter * scatterTint;
}

vec3 GetHairColorMarschner( vec3 N, vec3 V, vec3 L, float NdotL, float NdotV, float VdotL, float shadow, float backlit, float area, MaterialProperties material )
{
	return GetHairDiffuseColorMarschner( N, V, L, NdotL, NdotV, VdotL, backlit, area, material )
	       + GetHairDiffuseAttenuationKajiyaKay( N, V, L, NdotL, NdotV, shadow, material );
}

FuzzLayer CreateFuzzLayer( MaterialProperties material, float NdotV )
{
	FuzzLayer fuzz;
	fuzz.weight = 0.0;
	fuzz.color = vec3( 0.0 );
	fuzz.roughness = 0.0;
	fuzz.weightedAlbedo = 0.0;
	fuzz.specularThroughput = 1.0;
	fuzz.ltc = FuzzLTC( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), 0.0, 0.0 );

	if ( hasFlag( FLAG_FUZZ ) ) {
		fuzz.roughness = clamp( material.FuzzRoughness >= 0.0 ? material.FuzzRoughness : material.Roughness, 0.01, 1.0 );
		fuzz.weight = saturate( material.FuzzWeight );
		fuzz.weightedAlbedo = saturate( fuzz.weight * FuzzDirectionalAlbedo( NdotV, fuzz.roughness ) );
		fuzz.color = saturate( material.FuzzColor );
		fuzz.specularThroughput = material.FuzzRoughness < 0.0 ? 1.0 - fuzz.weight : 1.0 - fuzz.weightedAlbedo;
	}

	return fuzz;
}

void CacheFuzzLTC( inout FuzzLayer fuzz, vec3 N, vec3 V, float NdotV )
{
	if ( fuzz.weightedAlbedo > 0.0 )
		fuzz.ltc = CreateFuzzLTC( V, GetThinSurfaceNormal( N, V ), max( NdotV, EPSILON_DOT_CLAMP ), fuzz.roughness );
}

struct ThinSurface
{
	vec3 reflectionAlbedo;
	vec3 frontTransmissionAlbedo;
	vec3 backTransmissionAlbedo;
	vec3 specularAlbedo;
};

ThinSurface CreateThinSurface( MaterialProperties material, float NdotV, bool doSpecular, bool reflectionIncludesBaseColor )
{
	ThinSurface surface = ThinSurface( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	surface.reflectionAlbedo = reflectionIncludesBaseColor ? saturate( material.BaseColor ) : vec3( 1.0 );

	if ( hasFlag( FLAG_SUBSURFACE ) ) {
		float reflectionWeight;
		GetThinSurfaceSubsurfaceAlbedos( saturate( material.BaseColor ), saturate( material.SubsurfaceColor ), material.Thickness, material.SubsurfaceBalance,
			reflectionWeight, surface.frontTransmissionAlbedo, surface.backTransmissionAlbedo );
		surface.reflectionAlbedo *= reflectionWeight;
	}

	if ( doSpecular )
		surface.specularAlbedo = saturate( material.ThinSurfaceSpecularWeight ) * saturate( SpecularDirectionalAlbedo( material.F0, material.Roughness, NdotV ) );

	return surface;
}

struct DirectContext
{
	vec3 worldNormal;
	vec3 viewDir;
	vec3 lightDir;
	vec3 halfVector;
	vec3 lightColor;
	float detailedShadow;
	float softShadow;
	float backTransmissionVisibility;
	vec3 coatWorldNormal;
	vec3 coatViewDir;
	vec3 coatLightDir;
	vec3 coatHalfVector;
	vec3 coatLightColor;
};

struct DirectLightingOutput
{
	vec3 diffuse;
	vec3 coatDiffuse;
	vec3 specular;
	vec3 transmission;
};

DirectContext CreateDirectLightingContext( vec3 worldNormal, vec3 coatWorldNormal, vec3 viewDir, vec3 coatViewDir,
	vec3 lightDir, vec3 coatLightDir, vec3 lightColor, float detailedShadow, float softShadow )
{
	DirectContext context;
	context.worldNormal = normalize( worldNormal );
	context.viewDir = normalize( viewDir );
	context.lightDir = normalize( lightDir );
	context.halfVector = normalize( context.viewDir + context.lightDir );
	context.lightColor = lightColor;
	context.detailedShadow = detailedShadow;
	context.softShadow = softShadow;
	context.backTransmissionVisibility = 1.0;
	context.coatWorldNormal = normalize( coatWorldNormal );
	context.coatViewDir = normalize( coatViewDir );
	context.coatLightDir = normalize( coatLightDir );
	context.coatHalfVector = normalize( context.coatViewDir + context.coatLightDir );
	if ( hasFlag( FLAG_INTERLAYER_PARALLAX ) )
		context.coatLightColor = lightColor * softShadow;
	else
		context.coatLightColor = context.lightColor * detailedShadow;
	return context;
}

DirectLightingOutput GetDirectLightInputThinSurface( DirectContext context, MaterialProperties material, FuzzLayer fuzz,
	ThinSurface surface, float wrap, vec3 glintH )
{
	DirectLightingOutput lightingOutput = DirectLightingOutput( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );

	vec3 N = context.worldNormal;
	vec3 V = context.viewDir;
	vec3 L = context.lightDir;

	float NdotL = dot( N, L );
	vec3 specularNormal = GetThinSurfaceNormal( N, V );
	float NdotV = clamp( dot( specularNormal, V ), EPSILON_DOT_CLAMP, 1.0 );
	float specularNdotL = saturate( dot( specularNormal, L ) );

	float fuzzThroughput = 1.0 - fuzz.weightedAlbedo;
	vec3 scatteringThroughput = ( 1.0 - surface.specularAlbedo ) * fuzzThroughput;

	vec3 irradiance = context.lightColor * Diffuse_Lambert() * scatteringThroughput;
	vec3 shineThroughAlbedo = hasFlag( FLAG_SUBSURFACE ) ? material.BaseColor : vec3( 0.0 );

	GetThinSurfaceDirectScattering( surface.reflectionAlbedo, surface.frontTransmissionAlbedo, surface.backTransmissionAlbedo, shineThroughAlbedo,
		material.Thickness, irradiance, NdotL, wrap, context.detailedShadow, vec2( context.softShadow, context.softShadow * context.backTransmissionVisibility ),
		lightingOutput.diffuse, lightingOutput.transmission );

	vec3 H = context.halfVector;
	float NdotH = saturate( dot( specularNormal, H ) );
	float VdotH = saturate( dot( V, H ) );
	float D = GlintAwareD_GGX( material.Roughness, NdotH, glintH );
	float visibility = Vis_SmithJoint( material.Roughness, NdotV, max( specularNdotL, EPSILON_DOT_CLAMP ) );
	vec3 F = F_Schlick( material.F0, VdotH );
	vec3 detailedLightColor = context.lightColor * context.detailedShadow;
	lightingOutput.specular = saturate( material.ThinSurfaceSpecularWeight ) * D * visibility * F * detailedLightColor * specularNdotL * fuzz.specularThroughput;
	if ( fuzz.weightedAlbedo > 0.0 ) {
		vec3 fuzzReflection = FuzzLobe( L, fuzz.ltc ) * detailedLightColor;
		vec3 fuzzTransmission = surface.backTransmissionAlbedo * FuzzLobeTransmitted( L, fuzz.ltc ) *
		                        context.lightColor * context.softShadow * context.backTransmissionVisibility;
		lightingOutput.specular += fuzz.weightedAlbedo * fuzz.color * ( fuzzReflection + fuzzTransmission );
	}

	return lightingOutput;
}

// glintH: half vector in tangent space
DirectLightingOutput GetDirectLightInput( DirectContext context, MaterialProperties material, FuzzLayer fuzz, vec3 glintH )
{
	if ( IsThinSurfaceMaterial() ) {
		float NdotV = saturate( abs( dot( context.worldNormal, context.viewDir ) ) );
		ThinSurface surface = CreateThinSurface( material, NdotV, true, false );
		DirectLightingOutput lightingOutput = GetDirectLightInputThinSurface( context, material, fuzz, surface, 0.0, glintH );
		float microShadow = mix( 1.0, ApproximateDirectOcculusion( material.AO, dot( context.worldNormal, context.lightDir ) ), MICRO_SHADOW_STRENGTH );
		lightingOutput.diffuse *= microShadow;
		lightingOutput.specular *= microShadow;
		return lightingOutput;
	}

	DirectLightingOutput lightingOutput = DirectLightingOutput( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );

	vec3 detailedLightColor = context.lightColor * context.detailedShadow;
	vec3 softLightColor = context.lightColor * context.softShadow;

	vec3 N = context.worldNormal;
	vec3 V = context.viewDir;
	vec3 L = context.lightDir;
	vec3 H = context.halfVector;

	vec3 coatN = context.coatWorldNormal;
	vec3 coatV = context.coatViewDir;
	vec3 coatL = context.coatLightDir;
	vec3 coatH = context.coatHalfVector;

	float NdotL = dot( N, L );
	float NdotV = dot( N, V );
	float VdotL = dot( V, L );
	float NdotH = dot( N, H );
	float VdotH = dot( V, H );

	float satNdotL = clamp( NdotL, EPSILON_DOT_CLAMP, 1.0 );
	float satNdotV = saturate( abs( NdotV ) + EPSILON_DOT_CLAMP );
	float satNdotH = saturate( NdotH );
	float satVdotH = saturate( VdotH );

	float specularNdotL = satNdotL;
	float specularNdotV = satNdotV;
	if ( treeAnim ) {
		specularNdotL = saturate( NdotL );
		specularNdotV = clamp( NdotV, EPSILON_DOT_CLAMP, 1.0 );
	}

	if ( hasFlag( FLAG_HAIR_MARSCHNER ) ) {
		lightingOutput.transmission += softLightColor * GetHairColorMarschner( N, V, L, NdotL, NdotV, VdotL, 0.0, 1.0, 0.0, material );
	} else {
		vec3 F;	// Fresnel reflectance at current (V,H) angle
		vec3 Fr = SpecularMicrofacetWithGlint( material.Roughness, material.F0, max( specularNdotL, EPSILON_DOT_CLAMP ), specularNdotV, satNdotH, satVdotH, glintH, F );
		vec3 kD = 1.0 - F;
		if ( treeAnim )
			kD = 1.0 - saturate( SpecularDirectionalAlbedo( material.F0, material.Roughness, saturate( abs( NdotV ) ) ) );

		lightingOutput.diffuse += detailedLightColor * satNdotL * Diffuse_Lambert() * kD;
		lightingOutput.specular += Fr * detailedLightColor * specularNdotL;

		if ( !treeAnim && hasFlag( FLAG_SUBSURFACE ) ) {
			const float subsurfacePower = 12.234;
			float forwardScatter = exp2( saturate( -VdotL ) * subsurfacePower - subsurfacePower );
			float backScatter = saturate( satNdotL * material.Thickness + ( 1.0 - material.Thickness ) ) * 0.5;
			float subsurface = mix( backScatter, 1.0, forwardScatter ) * ( 1.0 - material.Thickness );
			vec3 transmissionKD = 1.0 - saturate( SpecularDirectionalAlbedo( material.F0, material.Roughness, saturate( abs( NdotV ) ) ) );
			lightingOutput.transmission += material.SubsurfaceColor * subsurface * softLightColor * Diffuse_Lambert() * transmissionKD;
		} else if ( hasFlag( FLAG_TWO_LAYER ) ) {
			float coatNdotL = satNdotL;
			float coatNdotV = satNdotV;
			float coatNdotH = satNdotH;
			float coatVdotH = satVdotH;
			if ( hasFlag( FLAG_COAT_NORMAL ) ) {
				coatNdotL = clamp( dot( coatN, coatL ), EPSILON_DOT_CLAMP, 1.0 );
				coatNdotV = saturate( abs( dot( coatN, coatV ) ) + EPSILON_DOT_CLAMP );
				coatNdotH = saturate( dot( coatN, coatH ) );
				coatVdotH = saturate( dot( coatV, coatH ) );
			}

			vec3 coatF;
			vec3 coatFr = SpecularMicrofacet( material.CoatRoughness, material.CoatF0, coatNdotL, coatNdotV, coatNdotH, coatVdotH, coatF );

			vec3 layerAttenuation = 1.0 - coatF * material.CoatStrength;
			lightingOutput.diffuse *= layerAttenuation;
			lightingOutput.specular *= layerAttenuation;

			lightingOutput.coatDiffuse += context.coatLightColor * coatNdotL * Diffuse_Lambert();
			lightingOutput.specular += coatFr * context.coatLightColor * coatNdotL * material.CoatStrength;
		}

		if ( hasFlag( FLAG_FUZZ ) ) {
			float throughput = 1.0 - fuzz.weightedAlbedo;

			lightingOutput.diffuse *= throughput;
			lightingOutput.specular *= fuzz.specularThroughput;
			lightingOutput.transmission *= throughput;
			lightingOutput.coatDiffuse *= throughput;

			if ( fuzz.weightedAlbedo > 0.0 )
				lightingOutput.specular += fuzz.weightedAlbedo * fuzz.color * FuzzLobe( L, fuzz.ltc ) * detailedLightColor;
		}
	}

	float microShadow = mix( 1.0, ApproximateDirectOcculusion( material.AO, NdotL ), MICRO_SHADOW_STRENGTH );
	lightingOutput.diffuse *= microShadow;
	lightingOutput.specular *= microShadow;
	lightingOutput.coatDiffuse *= microShadow;

	return lightingOutput;
}

struct IndirectLobeWeights
{
	vec3 diffuse;
	vec3 specular;
	vec3 frontTransmission;
	vec3 backTransmission;
};

IndirectLobeWeights GetIndirectLobeWeights( vec3 N, vec3 V, MaterialProperties material, FuzzLayer fuzz )
{
	IndirectLobeWeights lobeWeights = IndirectLobeWeights( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );

	if ( IsThinSurfaceMaterial() ) {
		float NdotV = saturate( abs( dot( N, V ) ) );
		ThinSurface surface = CreateThinSurface( material, NdotV, true, true );

		vec3 diffuseAO = saturate( MultiBounceAO( material.BaseColor, material.AO ) );
		float fuzzThroughput = 1.0 - fuzz.weightedAlbedo;
		vec3 substrateThroughput = diffuseAO * ( 1.0 - surface.specularAlbedo );
		vec3 scatteringThroughput = substrateThroughput * fuzzThroughput;
		lobeWeights.diffuse = surface.reflectionAlbedo * substrateThroughput * fuzzThroughput + fuzz.weightedAlbedo * fuzz.color * material.AO;
		lobeWeights.frontTransmission = surface.frontTransmissionAlbedo * scatteringThroughput;
		lobeWeights.backTransmission = surface.backTransmissionAlbedo * scatteringThroughput;

		float specNdotV = clamp( abs( dot( N, V ) ), EPSILON_DOT_CLAMP, 1.0 );
		lobeWeights.specular = surface.specularAlbedo * fuzz.specularThroughput *
		                       SpecularOcclusion( specNdotV, material.Roughness * material.Roughness, material.AO );
		return lobeWeights;
	}

	float NdotV = treeAnim ? saturate( dot( GetThinSurfaceNormal( N, V ), V ) ) : saturate( dot( N, V ) );

	if ( hasFlag( FLAG_HAIR_MARSCHNER ) ) {
		vec3 L = normalize( V - N * dot( V, N ) );
		float NdotL = dot( N, L );
		float VdotL = dot( V, L );
		lobeWeights.diffuse = GetHairColorMarschner( N, V, L, NdotL, NdotV, VdotL, 1.0, 0.0, 0.2, material );
	} else {
		lobeWeights.diffuse = material.BaseColor;
		if ( !treeAnim && hasFlag( FLAG_SUBSURFACE ) )
			lobeWeights.diffuse += material.SubsurfaceColor * ( 1.0 - material.Thickness ) / PI;

		lobeWeights.specular = SpecularDirectionalAlbedo( material.F0, material.Roughness, NdotV );
		if ( treeAnim )
			lobeWeights.specular = saturate( lobeWeights.specular );

		// Energy conservation: diffuse receives only what specular does not reflect
		lobeWeights.diffuse *= 1.0 - lobeWeights.specular;

		if ( hasFlag( FLAG_TWO_LAYER ) ) {
			vec2 coatSpecularBRDF = EnvBRDF( material.CoatRoughness, NdotV );
			vec3 coatSpecularLobeSpecular = material.CoatF0 * coatSpecularBRDF.x + coatSpecularBRDF.y;

			vec3 layerAttenuation = 1.0 - coatSpecularLobeSpecular * material.CoatStrength;
			lobeWeights.diffuse *= layerAttenuation;
			lobeWeights.specular *= layerAttenuation;

			if ( hasFlag( FLAG_COLORED_COAT ) ) {
				vec3 coatDiffuseLobeWeight = material.CoatColor * ( 1.0 - coatSpecularLobeSpecular );
				lobeWeights.diffuse += coatDiffuseLobeWeight * material.CoatStrength;
			}
			lobeWeights.specular += coatSpecularLobeSpecular * material.CoatStrength;
		}
	}

	// Apply ambient occlusion with multi-bounce approximation
	lobeWeights.diffuse *= MultiBounceAO( material.BaseColor, material.AO );
	float a = material.Roughness * material.Roughness;
	lobeWeights.specular *= SpecularOcclusion( NdotV, a, material.AO );

	if ( hasFlag( FLAG_FUZZ ) && !hasFlag( FLAG_HAIR_MARSCHNER ) ) {
		lobeWeights.diffuse = lobeWeights.diffuse * ( 1.0 - fuzz.weightedAlbedo ) + fuzz.weightedAlbedo * fuzz.color * material.AO;
		lobeWeights.specular *= fuzz.specularThroughput;
	}

	return lobeWeights;
}

// ---------------------------------------------------------------------------------------------------------------
// Extended Materials parallax (ExtendedMaterials.hlsli, ExtendedMaterialsParallaxCore.hlsli)

struct DisplacementParams
{
	float DisplacementScale;
	float DisplacementOffset;
	float HeightScale;
	float FlattenAmount;
};

float AdjustDisplacementNormalized( float displacement, DisplacementParams params )
{
	return ( displacement - 0.5 ) * params.DisplacementScale + 0.5 + params.DisplacementOffset;
}

vec4 AdjustDisplacementNormalized( vec4 displacement, DisplacementParams params )
{
	return ( displacement - 0.5 ) * params.DisplacementScale + 0.5 + params.DisplacementOffset;
}

float GetMipLevel( vec2 coords, sampler2D tex )
{
	vec2 texCoordsPerSize = coords * vec2( textureSize( tex, 0 ) );
	vec2 dxSize = dFdx( texCoordsPerSize );
	vec2 dySize = dFdy( texCoordsPerSize );
	float minTexCoordDelta = min( dot( dxSize, dxSize ), dot( dySize, dySize ) );
	float mipLevel = max( 0.5 * log2( minTexCoordDelta ), 0.0 );
	return floor( max( mipLevel, 0.0 ) );
}

// viewDirTS = view direction in tangent space
vec2 GetParallaxCoords( vec2 coords, float mipLevel, vec3 viewDirTS, DisplacementParams params )
{
	viewDirTS.xy /= viewDirTS.z * 0.7 + 0.3 + params.FlattenAmount;

	float nearBlendToFar = 0.0;
	float scale = params.HeightScale;
	float maxHeight = 0.1 * scale;
	float minHeight = maxHeight * 0.5;

	const float maxSteps = 16.0;
	uint numSteps = uint( ( maxSteps * ( 1.0 - nearBlendToFar ) ) + 0.5 );
	numSteps = clamp( numSteps, 4u, max( 4u, uint( scale * maxSteps ) ) );
	numSteps = ( numSteps + 2u ) & ~3u;

	float stepSize = 1.0 / float( numSteps );

	vec2 offsetPerStep = viewDirTS.xy * vec2( maxHeight ) * stepSize;
	vec2 prevOffset = viewDirTS.xy * vec2( minHeight ) + coords.xy;

	float prevBound = 1.0;
	float prevHeight = 1.0;

	vec2 pt1 = vec2( 0.0 );
	vec2 pt2 = vec2( 0.0 );

	uint numStepsTemp = numSteps;
	bool contactRefinement = false;

	for ( int i = 0; i < 512 && numSteps > 0u; i++ ) {
		vec4 currentOffset[2];
		currentOffset[0] = prevOffset.xyxy - vec4( 1.0, 1.0, 2.0, 2.0 ) * offsetPerStep.xyxy;
		currentOffset[1] = prevOffset.xyxy - vec4( 3.0, 3.0, 4.0, 4.0 ) * offsetPerStep.xyxy;
		vec4 currentBound = vec4( prevBound ) - vec4( 1.0, 2.0, 3.0, 4.0 ) * stepSize;

		vec4 currHeight;
		currHeight.x = textureLod( DisplacementMap, currentOffset[0].xy, mipLevel ).r;
		currHeight.y = textureLod( DisplacementMap, currentOffset[0].zw, mipLevel ).r;
		currHeight.z = textureLod( DisplacementMap, currentOffset[1].xy, mipLevel ).r;
		currHeight.w = textureLod( DisplacementMap, currentOffset[1].zw, mipLevel ).r;
		currHeight = AdjustDisplacementNormalized( currHeight, params );

		bvec4 testResult = greaterThanEqual( currHeight, currentBound );
		if ( any( testResult ) ) {
			vec2 outOffset = vec2( 0.0 );
			if ( testResult.w ) {
				outOffset = currentOffset[1].xy;
				pt1 = vec2( currentBound.w, currHeight.w );
				pt2 = vec2( currentBound.z, currHeight.z );
			}
			if ( testResult.z ) {
				outOffset = currentOffset[0].zw;
				pt1 = vec2( currentBound.z, currHeight.z );
				pt2 = vec2( currentBound.y, currHeight.y );
			}
			if ( testResult.y ) {
				outOffset = currentOffset[0].xy;
				pt1 = vec2( currentBound.y, currHeight.y );
				pt2 = vec2( currentBound.x, currHeight.x );
			}
			if ( testResult.x ) {
				outOffset = prevOffset;
				pt1 = vec2( currentBound.x, currHeight.x );
				pt2 = vec2( prevBound, prevHeight );
			}
			if ( contactRefinement ) {
				break;
			} else {
				contactRefinement = true;
				prevOffset = outOffset;
				prevBound = pt2.x;
				prevHeight = pt2.y;
				numSteps = numStepsTemp;
				stepSize /= float( numSteps );
				offsetPerStep /= float( numSteps );
				continue;
			}
		}

		prevOffset = currentOffset[1].zw;
		prevBound = currentBound.w;
		prevHeight = currHeight.w;
		numSteps -= 4u;
	}

	float delta2 = pt2.x - pt2.y;
	float delta1 = pt1.x - pt1.y;
	float denominator = delta2 - delta1;
	float parallaxAmount = ( denominator == 0.0 ? 0.0 : ( pt1.x * delta2 - pt2.x * delta1 ) / denominator );

	float offset = ( 1.0 - parallaxAmount ) * -maxHeight + minHeight;
	return viewDirTS.xy * offset + coords.xy;
}

// https://advances.realtimerendering.com/s2006/Tatarchuk-POM.pdf
float GetParallaxSoftShadowMultiplier( vec2 coords, float mipLevel, vec3 L, float sh0, float noise, DisplacementParams params )
{
	const float shadowIntensity = 2.0;
	sh0 = AdjustDisplacementNormalized( sh0, params );
	float shadowStrength = shadowIntensity * ( 4.0 / 4.0 );	// near quality: 4 taps
	vec2 rayDir = L.xy * 0.1 * params.HeightScale;
	vec4 multipliers = 1.0 / ( vec4( 1.0, 2.0, 3.0, 4.0 ) + noise );
	vec4 sh;
	sh.x = AdjustDisplacementNormalized( textureLod( DisplacementMap, coords + rayDir * multipliers.x, mipLevel ).r, params );
	sh.y = AdjustDisplacementNormalized( textureLod( DisplacementMap, coords + rayDir * multipliers.y, mipLevel ).r, params );
	sh.z = AdjustDisplacementNormalized( textureLod( DisplacementMap, coords + rayDir * multipliers.z, mipLevel ).r, params );
	sh.w = AdjustDisplacementNormalized( textureLod( DisplacementMap, coords + rayDir * multipliers.w, mipLevel ).r, params );
	return 1.0 - saturate( dot( max( vec4( 0.0 ), sh - sh0 ), vec4( shadowStrength ) ) );
}

float InterleavedGradientNoise( vec2 pxCoord )
{
	vec3 magic = vec3( 0.06711056, 0.00583715, 52.9829189 );
	return fract( magic.z * fract( dot( pxCoord, magic.xy ) ) );
}

// ---------------------------------------------------------------------------------------------------------------
// NifSkope environment

// Diffuse irradiance of the environment for a view space normal
vec3 ambientIrradiance( vec3 n )
{
	vec3 ambient = lightSourceAmbient.rgb;
	if ( hasCubeMap )
		return ambient * textureLod( CubeMap2, reflMatrix * n, 0.0 ).rgb;
	return ambient * 0.06666667;
}

// Pre-filtered specular radiance of the environment
vec3 specularIrradiance( vec3 n, vec3 v, float roughness )
{
	vec3 ambient = lightSourceAmbient.rgb;
	if ( !hasCubeMap )
		return ambient * 0.06666667;
	vec3 r = reflect( -v, n );
	float m = roughness * ( roughness * -4.0 + 10.0 );
	return ambient * textureLod( CubeMap, reflMatrix * r, max( m, 0.0 ) ).rgb;
}

vec3 tonemap( vec3 x, float y )
{
	float a = 0.15;
	float b = 0.50;
	float c = 0.10;
	float d = 0.20;
	float e = 0.02;
	float f = 0.30;

	vec3 z = x * ( y * 4.22978723 );
	z = ( z * ( a * z + b * c ) + d * e ) / ( z * ( a * z + b ) + d * f ) - e / f;
	return z / ( y * 0.93333333 );
}

void main()
{
	vec2 uv = texCoord * uvScale + uvOffset;
	vec2 uvOriginal = uv;

	vec3 viewDirection = normalize( ViewDir );
	vec3 lightDirection = normalize( LightDir );

	bool isFoliage = IsFoliageMaterial();
	bool isThinSurface = IsThinSurfaceMaterial();
	bool foliageNormals = treeAnim || isFoliage;
	bool thinSurfaceNormals = foliageNormals || isThinSurface;
	vec3 thinSurfaceFaceNormal = GetThinSurfaceFaceNormal( ViewPos, viewDirection, vec3( 0.0, 0.0, 1.0 ) );
	bool frontFace = gl_FrontFacing;

	// btnMatrix columns: bitangent, tangent and normal in view space (the Bethesda names are swapped)
	mat3 tbn = mat3( normalize( btnMatrix[0] ), normalize( btnMatrix[1] ), normalize( btnMatrix[2] ) );
	// Fix incorrect vertex normals on double-sided meshes, and face thin surfaces to the viewer
	if ( !frontFace && ( thinSurfaceNormals || !treeAnim ) )
		tbn = -tbn;

	float screenNoise = InterleavedGradientNoise( gl_FragCoord.xy );

	// Coat color and strength
	vec4 sampledCoatColor = pbrParams2;
	if ( hasFlag( FLAG_HAS_FEATURE_TEXTURE0 ) ) {
		vec4 sampledCoatProperties = texture( FeatureMap0, uv );
		sampledCoatColor.rgb *= sampledCoatProperties.rgb;
		sampledCoatColor.a *= sampledCoatProperties.a;
	}

	// Parallax
	vec3 refractedViewDirection = viewDirection;
	float eta = 1.0;
	bool pbrParallax = false;
	float mipLevel = 0.0;
	float sh0 = 0.0;
	DisplacementParams displacementParams = DisplacementParams( 1.0, 0.0, 1.0, 0.0 );
	if ( hasFlag( FLAG_HAS_DISPLACEMENT ) ) {
		pbrParallax = true;
		displacementParams.HeightScale *= pbrParams1.y;
		if ( hasFlag( FLAG_INTERLAYER_PARALLAX ) ) {
			displacementParams.DisplacementScale = 0.5;
			displacementParams.DisplacementOffset = -0.25;

			eta = mix( 1.0, ( 1.0 - sqrt( layerParams.y ) ) / ( 1.0 + sqrt( layerParams.y ) ), sampledCoatColor.a );
			vec3 entryNormalTS;
			if ( hasFlag( FLAG_COAT_NORMAL ) )
				entryNormalTS = normalize( texture( FeatureMap1, uvOriginal ).rgb * 2.0 - 1.0 );
			else
				entryNormalTS = normalize( texture( NormalMap, uvOriginal ).rgb * 2.0 - 1.0 );
			vec3 entryNormal = normalize( tbn * entryNormalTS );
			refractedViewDirection = -refract( -viewDirection, entryNormal, eta );
		}
		mipLevel = GetMipLevel( uv, DisplacementMap );
		uv = GetParallaxCoords( uv, mipLevel, normalize( refractedViewDirection * tbn ), displacementParams );
		sh0 = textureLod( DisplacementMap, uv, mipLevel ).r;
	}

	vec4 baseMap = texture( BaseMap, uv );

	vec4 color = vec4( 0.0, 0.0, 0.0, 1.0 );
	if ( alphaFlags > 0 ) {
		float a = C.a * baseMap.a * alpha;
		// 0: always, 1: <, 2: ==, 3: <=, 4: >, 5: !=, 6: >=, 7: never
		int m = ( a < alphaThreshold ? 0x2B2B : ( a > alphaThreshold ? 0x7171 : 0x4D4D ) );
		if ( ( m & ( 1 << alphaFlags ) ) == 0 )
			discard;
		if ( ( alphaFlags & 8 ) != 0 )
			color.a = a;
	}

	vec3 worldNormal = normalize( tbn * ( texture( NormalMap, uv ).rgb * 2.0 - 1.0 ) );

	// Material
	vec4 rawRMAOS = texture( RMAOSMap, uv ) * vec4( pbrParams1.x, 1.0, 1.0, pbrParams1.z );

	MaterialProperties material;
	material.Roughness = clamp( rawRMAOS.x, MIN_ROUGHNESS, MAX_ROUGHNESS );
	material.ThinSurfaceSpecularWeight = 1.0;
	if ( isThinSurface ) {
		material.ThinSurfaceSpecularWeight = saturate( frontFace ? thinSurfaceParams.y : thinSurfaceParams.z );
		material.Roughness = clamp( rawRMAOS.x * ( frontFace ? 1.0 : thinSurfaceParams.w ), MIN_ROUGHNESS, MAX_ROUGHNESS );
	}
	if ( foliageNormals )
		material.Roughness = FilterFoliageRoughness( material.Roughness, dFdx( worldNormal ), dFdy( worldNormal ) );
	material.Metallic = saturate( rawRMAOS.y );
	material.AO = rawRMAOS.z;

	// Vertex color (sRGB), applied to the base color so that metals use it
	vec3 pbrVertexColor = srgbToLinear( C.rgb );
	vec3 baseColor = baseMap.rgb * pbrVertexColor;
	material.F0 = mix( vec3( rawRMAOS.w ), baseColor, material.Metallic );
	// Glint parameters: screen space scale, log microfacet density, microfacet roughness, density randomization
	materialNoise = screenNoise;
	if ( hasFlag( FLAG_GLINT ) ) {
		glintEnabled = true;
		float glintScreenSpaceScale = max( 1.0, layerParams.x );
		glintLogMicrofacetDensity = clamp( layerParams.y, 1.0, 40.0 );
		glintMicrofacetRoughness = clamp( layerParams.z, 0.005, 0.3 );
		glintDensityRandomization = clamp( layerParams.w, 0.0, 5.0 );
		float glintNoise = float( pcg2d( uvec2( gl_FragCoord.xy ) ).x ) / 4294967296.0;
		PrecomputeGlints( glintNoise, uvOriginal, dFdx( uvOriginal ), dFdy( uvOriginal ), glintScreenSpaceScale, glintCache );
	}

	baseColor *= 1.0 - material.Metallic;
	material.BaseColor = baseColor;

	material.SubsurfaceColor = vec3( 0.0 );
	material.Thickness = 0.0;
	material.SubsurfaceBalance = 0.0;
	material.CoatColor = vec3( 0.0 );
	material.CoatStrength = 0.0;
	material.CoatRoughness = 0.0;
	material.CoatF0 = vec3( 0.0 );
	material.FuzzColor = vec3( 0.0 );
	material.FuzzWeight = 0.0;
	material.FuzzRoughness = 0.0;

	vec3 coatWorldNormal = worldNormal;
	if ( hasFlag( FLAG_SUBSURFACE ) ) {
		material.SubsurfaceColor = pbrParams2.rgb;
		material.Thickness = pbrParams2.a;
		material.SubsurfaceBalance = thinSurfaceParams.x;
		if ( hasFlag( FLAG_HAS_FEATURE_TEXTURE0 ) ) {
			vec4 sampledSubsurfaceProperties = texture( FeatureMap0, uv );
			material.SubsurfaceColor *= sampledSubsurfaceProperties.rgb;
			material.SubsurfaceColor *= pbrVertexColor;
			material.Thickness *= sampledSubsurfaceProperties.a;
		} else if ( isThinSurface ) {
			material.SubsurfaceColor *= material.BaseColor;
		}
	} else if ( hasFlag( FLAG_TWO_LAYER ) ) {
		material.CoatColor = sampledCoatColor.rgb;
		material.CoatStrength = sampledCoatColor.a;
		material.CoatRoughness = layerParams.x;
		material.CoatF0 = vec3( layerParams.y );

		vec2 coatUv = hasFlag( FLAG_INTERLAYER_PARALLAX ) ? uvOriginal : uv;
		if ( hasFlag( FLAG_HAS_FEATURE_TEXTURE1 ) ) {
			vec4 sampledCoatProperties = texture( FeatureMap1, coatUv );
			material.CoatRoughness *= sampledCoatProperties.a;
			if ( hasFlag( FLAG_COAT_NORMAL ) )
				coatWorldNormal = normalize( tbn * ( sampledCoatProperties.rgb * 2.0 - 1.0 ) );
		}
	}

	if ( hasFlag( FLAG_FUZZ ) ) {
		material.FuzzColor = layerParams.rgb;
		material.FuzzWeight = layerParams.a;
		material.FuzzRoughness = fuzzRoughness;
		if ( hasFlag( FLAG_HAS_FEATURE_TEXTURE1 ) ) {
			vec4 sampledFuzzProperties = texture( FeatureMap1, uv );
			material.FuzzColor *= sampledFuzzProperties.rgb;
			material.FuzzWeight *= sampledFuzzProperties.a;
		}
		if ( hasFlag( FLAG_HAS_FUZZ_ROUGHNESS_TEXTURE ) )
			material.FuzzRoughness = texture( DisplacementMap, uv ).g;
	}

	// Directional light, scaled so that a white Lambert surface facing it reflects the light color
	vec3 dirLightColor = lightSourceDiffuse[0].rgb * PI;
	vec3 refractedDirLightDirection = lightDirection;
	if ( hasFlag( FLAG_INTERLAYER_PARALLAX ) && dot( lightDirection, coatWorldNormal ) > 0.0 )
		refractedDirLightDirection = -refract( -lightDirection, coatWorldNormal, eta );

	float dirDetailedShadow = 1.0;
	float dirSoftShadow = 1.0;
	if ( pbrParallax )
		dirDetailedShadow *= GetParallaxSoftShadowMultiplier( uv, mipLevel, refractedDirLightDirection * tbn, sh0, screenNoise, displacementParams );

	DirectContext dirLightContext = CreateDirectLightingContext( worldNormal, coatWorldNormal, refractedViewDirection, viewDirection,
		refractedDirLightDirection, lightDirection, dirLightColor, dirDetailedShadow, dirSoftShadow );
	float directFuzzNdotV = clamp( abs( dot( dirLightContext.worldNormal, dirLightContext.viewDir ) ), isThinSurface ? 0.0 : EPSILON_DOT_CLAMP, 1.0 );
	FuzzLayer fuzz = CreateFuzzLayer( material, directFuzzNdotV );
	CacheFuzzLTC( fuzz, dirLightContext.worldNormal, dirLightContext.viewDir, directFuzzNdotV );
	if ( thinSurfaceNormals )
		dirLightContext.backTransmissionVisibility = GetThinSurfaceBackTransmissionVisibility( thinSurfaceFaceNormal, lightDirection );

	DirectLightingOutput dirLightOutput = GetDirectLightInput( dirLightContext, material, fuzz, dirLightContext.halfVector * tbn );
	if ( !hasSpecular )
		dirLightOutput.specular = vec3( 0.0 );

	// Indirect lighting
	vec3 ambientNormal = worldNormal;
	float indirectFuzzNdotV = clamp( abs( dot( ambientNormal, viewDirection ) ), isThinSurface ? 0.0 : EPSILON_DOT_CLAMP, 1.0 );
	if ( indirectFuzzNdotV != directFuzzNdotV )
		fuzz = CreateFuzzLayer( material, indirectFuzzNdotV );
	IndirectLobeWeights indirectLobeWeights = GetIndirectLobeWeights( ambientNormal, viewDirection, material, fuzz );

	// Composition
	vec3 directLightsDiffuseInput = dirLightOutput.diffuse * material.BaseColor;
	if ( hasFlag( FLAG_COLORED_COAT ) )
		directLightsDiffuseInput = mix( directLightsDiffuseInput, material.CoatColor * dirLightOutput.coatDiffuse, material.CoatStrength );
	color.rgb = directLightsDiffuseInput;

	if ( hasFlag( FLAG_HAS_EMISSIVE ) ) {
		vec3 glowColor = texture( EmissiveMap, uv ).rgb * GLOWMAP_MULT;
		color.rgb += srgbToLinear( emissiveColor ) * emissiveMult * glowColor * pbrVertexColor * glowScale;
	}

	color.rgb += indirectLobeWeights.diffuse * ambientIrradiance( ambientNormal );
	color.rgb += dirLightOutput.transmission;

	if ( any( greaterThan( indirectLobeWeights.frontTransmission, vec3( 0.0 ) ) ) )
		color.rgb += indirectLobeWeights.frontTransmission * ambientIrradiance( ambientNormal );
	if ( any( greaterThan( indirectLobeWeights.backTransmission, vec3( 0.0 ) ) ) )
		color.rgb += indirectLobeWeights.backTransmission * ambientIrradiance( -ambientNormal );

	color.rgb += dirLightOutput.specular;
	if ( hasSpecular && any( greaterThan( indirectLobeWeights.specular, vec3( 0.0 ) ) ) ) {
		vec3 specularNormal = thinSurfaceNormals ? GetThinSurfaceNormal( worldNormal, viewDirection ) : worldNormal;
		color.rgb += indirectLobeWeights.specular * specularIrradiance( specularNormal, viewDirection, material.Roughness );
	}

	color.rgb = tonemap( color.rgb * brightnessScale, toneMapScale );
	fragColor = vec4( linearToSrgb( color.rgb ), color.a );
}
