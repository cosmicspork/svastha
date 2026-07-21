# Changelog

## [0.8.0](https://github.com/cosmicspork/svastha/compare/v0.7.0...v0.8.0) (2026-07-21)


### Features

* **web:** cycle event modeling foundation ([#78](https://github.com/cosmicspork/svastha/issues/78)) ([42d3185](https://github.com/cosmicspork/svastha/commit/42d3185874b6f006b092f3a856ab8ed4d2c62c94))
* **web:** cycle log form and timeline ([#80](https://github.com/cosmicspork/svastha/issues/80)) ([8d857a7](https://github.com/cosmicspork/svastha/commit/8d857a72ae77b087246ab9ae5cc07047ff29d138))
* **web:** cycle stats and Patterns lane ([#82](https://github.com/cosmicspork/svastha/issues/82)) ([49532e2](https://github.com/cosmicspork/svastha/commit/49532e2729928d8957032d0698c27c0d0b9d7979))
* **web:** opt-in sharing for sensitive categories and clinician cycle summary ([#81](https://github.com/cosmicspork/svastha/issues/81)) ([c989697](https://github.com/cosmicspork/svastha/commit/c989697de8521366f24538ca74f9271a0434e6ec))
* **web:** show version info on unlock and onboard pages ([4f59d74](https://github.com/cosmicspork/svastha/commit/4f59d74cecbd6c1f1e8685b0aa1520aa8db52b2d))

## [0.7.0](https://github.com/cosmicspork/svastha/compare/v0.6.0...v0.7.0) (2026-07-15)


### Features

* **core:** add Attachment event value for captured documents ([b88b67f](https://github.com/cosmicspork/svastha/commit/b88b67f711771608010761279ddb9c9413e66cef))
* **devtool:** add headless re-import subcommand ([3589502](https://github.com/cosmicspork/svastha/commit/3589502c0becac003303d17b410f573c0f7bf701))
* import narrative visit notes and nest them under their encounter ([8912f54](https://github.com/cosmicspork/svastha/commit/8912f54946f8221bfa5d223d9487f06b168fce2d))
* **import:** map C-CDA narrative prose sections to note events ([67f6291](https://github.com/cosmicspork/svastha/commit/67f6291dcfe5a05e350693d9ed1c716b5953af7a))
* paper record attachments ([e2632d5](https://github.com/cosmicspork/svastha/commit/e2632d5aaa20552a2b16ccab94fb8e5430c3f60d))
* **web:** add code dictionary settings controls ([21ee5b7](https://github.com/cosmicspork/svastha/commit/21ee5b73653bc01be089e947f856220aeabb8d6b))
* **web:** capture paper records from the log bloom ([727994b](https://github.com/cosmicspork/svastha/commit/727994bf9046ffc04ff86697dfeab4d22b858e2e))
* **web:** full-screen viewer for captured paper records ([bea54c2](https://github.com/cosmicspork/svastha/commit/bea54c26b5247bb562df1cdd19386dbae1f94d59))
* **web:** generate offline clinical code dictionaries ([a26b79a](https://github.com/cosmicspork/svastha/commit/a26b79a0c008a376b13ba71b09c5977c5652e6f0))
* **web:** include captured paper records in doctor shares ([89ed8bf](https://github.com/cosmicspork/svastha/commit/89ed8bf4fce5d81258d28ec676e785870dfbcf57))
* **web:** nest imported visit notes under their encounter on the spine ([cd18b15](https://github.com/cosmicspork/svastha/commit/cd18b1586f4893a840d90579f91c82dc51d1dff3))
* **web:** optional offline code dictionary ([3868ae6](https://github.com/cosmicspork/svastha/commit/3868ae68fc55437fc692a24b063bb0b58ae7d487))
* **web:** resolve display names for null-display coded events ([000ea49](https://github.com/cosmicspork/svastha/commit/000ea493bf87353f887b0d6b75cd5e0fdbf5553a))
* **web:** resolve labels from the offline code dictionary ([1aeaa6d](https://github.com/cosmicspork/svastha/commit/1aeaa6deed6be31f08cbb8e600fda9b7c2133c9a))
* **web:** show the release version in Settings About ([f9494d5](https://github.com/cosmicspork/svastha/commit/f9494d50a991acf73cb63ebf74be86dc9155b633))
* **web:** store and load the offline code dictionary ([90e3f75](https://github.com/cosmicspork/svastha/commit/90e3f7568d69adf2b6b3f57eb4ab22704561bb7c))
* **web:** store and sync captured-document attachments ([6d8dfd9](https://github.com/cosmicspork/svastha/commit/6d8dfd96d0abe8c1cbc72f6e880bfdb197ef8e07))
* **web:** warn when an imported document is too large to sync ([7af3de7](https://github.com/cosmicspork/svastha/commit/7af3de73d34d86f745f5f187e59e639c4780d254))


### Bug Fixes

* **web:** keep a summary document's notes standalone across visit days ([5a7008f](https://github.com/cosmicspork/svastha/commit/5a7008f8cb1c26c0cc03d58f15af4455e1d6cee6))
* **web:** pin passkeys to the platform authenticator and surface ceremony failures ([bf056c9](https://github.com/cosmicspork/svastha/commit/bf056c98f37b1f79589474b70a1863ee29fddc37))
* **web:** spine row titles for imported meds and stable chevron layout ([d8402f8](https://github.com/cosmicspork/svastha/commit/d8402f8d43a0b6b001eeaea13fe45c5a42a51048))

## [0.6.0](https://github.com/cosmicspork/svastha/compare/v0.5.1...v0.6.0) (2026-07-14)


### Features

* **relay:** share token store and endpoints ([c66dc6e](https://github.com/cosmicspork/svastha/commit/c66dc6e6aa2fa685c90ee272e6fc7c54dd05dfc0))
* **web:** clinician summary derivation ([0e03db8](https://github.com/cosmicspork/svastha/commit/0e03db89b7c05af8f250345b8813b8a4beb72458))
* **web:** clinician summary view and toggle ([edd0c25](https://github.com/cosmicspork/svastha/commit/edd0c255357ba0a77e52fe2d2bcae9d4b18f1587))
* **web:** doctor share creation with QR link ([a017ca4](https://github.com/cosmicspork/svastha/commit/a017ca420713bba57809b7e743b86d11d3b52af5))
* **web:** expand spine rows into an inline provenance panel ([e72101b](https://github.com/cosmicspork/svastha/commit/e72101b77f66f3d4a751eb0343cae64c2f399ee9))
* **web:** share recipient view ([8940c4b](https://github.com/cosmicspork/svastha/commit/8940c4bd57b4b615361ad429a0af2e5e736b0dd3))
* **web:** show event details on spine rows ([fbca9d1](https://github.com/cosmicspork/svastha/commit/fbca9d15a04da1119c138bbf7abd80a2a3075af2))
* **web:** spine entry overflow menu ([190eff2](https://github.com/cosmicspork/svastha/commit/190eff262ba5b177ab45b003ecded6c4ed3b450c))


### Bug Fixes

* **relay:** bind share tokens to their creating owner ([992a1f3](https://github.com/cosmicspork/svastha/commit/992a1f3f93751d77cad51a4cb2986a94688fe5c2))
* **web:** format quantity values and coding hints on clinical spine rows ([87826d5](https://github.com/cosmicspork/svastha/commit/87826d56fe1daaf04e116105c0b85bcb9be54ff0))

## [0.5.1](https://github.com/cosmicspork/svastha/compare/v0.5.0...v0.5.1) (2026-07-14)


### Bug Fixes

* **relay:** lift axum default body limit to MAX_BODY ([e7822dd](https://github.com/cosmicspork/svastha/commit/e7822dd4c49ad24248deb3b5ddcc160f77e199cd))

## [0.5.0](https://github.com/cosmicspork/svastha/compare/v0.4.0...v0.5.0) (2026-07-11)


### Features

* **web:** encrypted export and import with automatic dedupe ([ebb13a8](https://github.com/cosmicspork/svastha/commit/ebb13a81da87f99fbff25ae85487338562929427))
* **web:** unencrypted JSON export from Settings ([5c64c25](https://github.com/cosmicspork/svastha/commit/5c64c25cfb38910c90bbda152ba4abb46ca3803c))


### Bug Fixes

* **web:** wrap long spine values to stop mobile horizontal overflow ([5ded627](https://github.com/cosmicspork/svastha/commit/5ded6272df3bf254175c2c6becc5b9120c9b407f))

## [0.4.0](https://github.com/cosmicspork/svastha/compare/v0.3.0...v0.4.0) (2026-07-10)


### Features

* **web:** keyvault master-key indirection with v1-&gt;v2 migration ([d683a0f](https://github.com/cosmicspork/svastha/commit/d683a0f8e42a83ebacfa286f51d81520fa478698))
* **web:** unlock the vault with a passkey via WebAuthn PRF ([4cab034](https://github.com/cosmicspork/svastha/commit/4cab0345db313a072dd44c2e6eabc0f798a0e0c6))


### Bug Fixes

* **web:** iOS viewport/safe-area fixes and in-field unlock reveal ([de6f08d](https://github.com/cosmicspork/svastha/commit/de6f08da837bd997354fe6b7fe669c264b6be4b4))
* **web:** mark onboarding passphrases as new-password for autofill ([ab9bb1d](https://github.com/cosmicspork/svastha/commit/ab9bb1d9b1e9d509349e7660591576dc3da0ad20))
* **web:** offset iOS safe areas at the top and size the page to the visible viewport ([c0f2bf0](https://github.com/cosmicspork/svastha/commit/c0f2bf0f533a917456270086bfd1bd01d4687922))

## [0.3.0](https://github.com/cosmicspork/svastha/compare/v0.2.0...v0.3.0) (2026-07-06)


### Features

* qr linking via relay landing page and device link codes ([ee730e4](https://github.com/cosmicspork/svastha/commit/ee730e4d156585ab0caa3be3a29bb83f07302d18))
* **web:** add design tokens and shared control styles ([b6e58d6](https://github.com/cosmicspork/svastha/commit/b6e58d682bd4557b3bc3886fd9d1a834ce4efb00))
* **web:** in-app theme setting and honest appearance controls ([c858453](https://github.com/cosmicspork/svastha/commit/c858453264ad66a3e552149efe8a4650383502ed))
* **web:** mindfulness logging with mood and gratitude ([dbe9f97](https://github.com/cosmicspork/svastha/commit/dbe9f9735900e63ad0342826c701d78097af5d0a))
* **web:** move log form actions into fixed bottom bar ([f8b2993](https://github.com/cosmicspork/svastha/commit/f8b2993d0cfaa31d5d1a19fec3ad71a238017ddb))
* **web:** one-time home screen install sheet ([e2d0325](https://github.com/cosmicspork/svastha/commit/e2d03252f5b642e03f9ef99c6d4cf55603857874))
* **web:** replace bottom bar with frequency-ordered bloom fab ([1017ce9](https://github.com/cosmicspork/svastha/commit/1017ce98ee92364aa849c0881d6c4e1048a8aaf7))
* **web:** seed phrase copy with clipboard auto-clear ([24e0046](https://github.com/cosmicspork/svastha/commit/24e004688277ce611e3e8efe0512b3ccfddc27cd))
* **web:** unlock screen redesign with vault seal and fingerprint ([b38dcea](https://github.com/cosmicspork/svastha/commit/b38dceafdd06333aefef74dbad8d6029c3d24da9))

## [0.2.0](https://github.com/cosmicspork/svastha/compare/v0.1.0...v0.2.0) (2026-07-05)


### Features

* **import:** map administered and discharge medication sections ([ad7bed0](https://github.com/cosmicspork/svastha/commit/ad7bed02cab37e57d161df46d47c3dcd21e58de5))
* **import:** map encounter-nested procedures and resolve ST narrative references ([cb0aab7](https://github.com/cosmicspork/svastha/commit/cb0aab7804241aa8e389ebd9033881d17c02b979))


### Bug Fixes

* **web:** replace scaffold favicon with the spine mark ([4e9d86a](https://github.com/cosmicspork/svastha/commit/4e9d86a622c05b3dd3fa75bce27256a163bcf503))

## [0.1.0](https://github.com/cosmicspork/svastha/compare/v0.0.1...v0.1.0) (2026-07-05)


### Features

* client-side C-CDA and FHIR import with provenance blobs ([83daeb7](https://github.com/cosmicspork/svastha/commit/83daeb7db263d611ea2553b9f90ecc5096a4556b))
* **core:** add nutrition_intake event kind ([20cae32](https://github.com/cosmicspork/svastha/commit/20cae32d9d2f655f3ccee1a33732a266a26498db))
* household sharing via relay grants and wrapped-key mailbox ([c903b77](https://github.com/cosmicspork/svastha/commit/c903b776d01039174885a3a626acec31ec391775))
* **web:** app shell, local storage, and passphrase key custody ([74cdf0a](https://github.com/cosmicspork/svastha/commit/74cdf0a49f8bd445f3d4bc3ecb9809e39697e14f))
* **web:** curation overlay and correlation views ([f451dc6](https://github.com/cosmicspork/svastha/commit/f451dc6a34eaa776fe11c4529687cabea6c1dbb4))
* **web:** encrypted relay backup and multi-device sync ([ab1591e](https://github.com/cosmicspork/svastha/commit/ab1591ebcd89707a9d38b595a138fc8d5478e6ca))
* **web:** quick-log forms and the spine timeline ([2f8fd12](https://github.com/cosmicspork/svastha/commit/2f8fd127fa9602372477e2d577c7240a90ff216b))

## 0.0.1 (2026-06-08)


### Features

* **core:** add encryption envelope (XChaCha20-Poly1305 sealing + X25519 key wrapping) ([588d43e](https://github.com/cosmicspork/svastha/commit/588d43e841ff720dbe4e90b8cdecb371fe59db6f))
* **core:** add relay auth handshake (signed-request contract) ([8a2249b](https://github.com/cosmicspork/svastha/commit/8a2249b6fd95bd82e78b630990622c53ed036efa))
* **core:** content-address and sign events ([baabe5c](https://github.com/cosmicspork/svastha/commit/baabe5c0f3b5d5b51a776f6767bee19158acaf1f))
* **core:** derive X25519 and Ed25519 identity keys from BIP39 seed ([aa0d270](https://github.com/cosmicspork/svastha/commit/aa0d27085aacd7a3d16a3d85715c35d2cc91094d))
* **relay:** add durable filesystem blob store ([5468c73](https://github.com/cosmicspork/svastha/commit/5468c73e77df76d3aad28523b09efcc5e7dc0033))
* **relay:** zero-knowledge blob store-and-forward server ([223db42](https://github.com/cosmicspork/svastha/commit/223db420e0cfdc926f9df1be0b87efae883df575))
* **svastha:** add umbrella crate re-exporting the trust contract ([46d2ccc](https://github.com/cosmicspork/svastha/commit/46d2cccddbcd068c3650f401f389e649330af8c3))
* **web:** relay HTTP client and a local PWA↔relay e2e smoke ([c174832](https://github.com/cosmicspork/svastha/commit/c174832835775db2bff8782294fc31e35fb70ae6))
* **web:** run the trust contract in the browser over WASM ([9305c3e](https://github.com/cosmicspork/svastha/commit/9305c3ea5897fc34ed3953969180429657851a1b))


### Bug Fixes

* **ci:** use release-please simple type for the cargo workspace ([11f1d00](https://github.com/cosmicspork/svastha/commit/11f1d005c949d17687c8b730ba4e43ffc6d2ff3b))
