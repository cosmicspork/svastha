# Changelog

## [0.14.0](https://github.com/cosmicspork/svastha/compare/v0.13.0...v0.14.0) (2026-07-31)


### ⚠ BREAKING CHANGES

* **ai:** one AI screen, and each owner brings their own node endpoint ([#178](https://github.com/cosmicspork/svastha/issues/178))
* **node:** scope reading pause to the owner who sent it ([#167](https://github.com/cosmicspork/svastha/issues/167))

### Features

* **ai:** keep sensitive categories out of answers unless opted in ([#170](https://github.com/cosmicspork/svastha/issues/170)) ([41097e4](https://github.com/cosmicspork/svastha/commit/41097e440559e482ec0e844ccfbdc131e9ccde3e))
* **ai:** one AI screen, and each owner brings their own node endpoint ([#178](https://github.com/cosmicspork/svastha/issues/178)) ([31c6d9e](https://github.com/cosmicspork/svastha/commit/31c6d9e1392c2bdc96eb2575f6ed2778a87e5127))
* **devtool:** score the page readers against fixture pages ([#177](https://github.com/cosmicspork/svastha/issues/177)) ([0435103](https://github.com/cosmicspork/svastha/commit/0435103f931f710f4b7762dd6c831595488e3deb))
* **node:** pause page reading by default and cap each pass ([#157](https://github.com/cosmicspork/svastha/issues/157)) ([a28be3b](https://github.com/cosmicspork/svastha/commit/a28be3b2a37f2a19122ead7286bdadc3687d2f75))
* **node:** two-stage extraction with in-process OCR ([#156](https://github.com/cosmicspork/svastha/issues/156)) ([1f72aea](https://github.com/cosmicspork/svastha/commit/1f72aeabdc523f21e872d14a53212c683bbffaa5))
* **relay:** batched blob fetch via include=body on the listings ([#146](https://github.com/cosmicspork/svastha/issues/146)) ([a7884c2](https://github.com/cosmicspork/svastha/commit/a7884c26a7cfbd620f3c7df7ec43933ed06074e3))
* **web:** answer questions on this device ([#151](https://github.com/cosmicspork/svastha/issues/151)) ([36c793e](https://github.com/cosmicspork/svastha/commit/36c793e61d8afb5d04252a5c8adc604b82b33a63))
* **web:** bulk "read my unread pages" ([#179](https://github.com/cosmicspork/svastha/issues/179)) ([af84e06](https://github.com/cosmicspork/svastha/commit/af84e06b421e4c78805a620b6dc130e97c784a3c))
* **web:** configure an inference endpoint on this device ([#150](https://github.com/cosmicspork/svastha/issues/150)) ([6f11171](https://github.com/cosmicspork/svastha/commit/6f11171648a92c7fa1f7404c9e8711ac00a7c7b1))
* **web:** give the ask screen a front door, an honest pill, and a visible failure state ([#174](https://github.com/cosmicspork/svastha/issues/174)) ([2c93609](https://github.com/cosmicspork/svastha/commit/2c936098c3db73f224c357f3559f29c1bb5aeea4))
* **web:** on-device reading defaults to on ([#180](https://github.com/cosmicspork/svastha/issues/180)) ([c7ebd52](https://github.com/cosmicspork/svastha/commit/c7ebd5294c89fd9486ef8b0170e1f40bfa5043ad))
* **web:** optional on-device OCR for photographed pages ([#154](https://github.com/cosmicspork/svastha/issues/154)) ([6696554](https://github.com/cosmicspork/svastha/commit/66965545a29f6af627d2c89a0190209e273ce4e1))
* **web:** paginate proposal groups and confirm approve-all ([#175](https://github.com/cosmicspork/svastha/issues/175)) ([8aee8ad](https://github.com/cosmicspork/svastha/commit/8aee8ad7ad94e96eb715bf92ba15121949b3ff2d))
* **web:** propose coded events from pages read on this device ([#155](https://github.com/cosmicspork/svastha/issues/155)) ([aba5dec](https://github.com/cosmicspork/svastha/commit/aba5dec4121ea85d5fea89fe1295e0e439e1dd5a))
* **web:** read text from digital PDF attachments ([#152](https://github.com/cosmicspork/svastha/issues/152)) ([e14f1a1](https://github.com/cosmicspork/svastha/commit/e14f1a1be8319285759db16a2eec54a08af4cfae))
* **web:** surface read-page outcomes in the viewer and make re-reads real ([#176](https://github.com/cosmicspork/svastha/issues/176)) ([96fd10e](https://github.com/cosmicspork/svastha/commit/96fd10ef7fdb4d810923ccdc106d2d3e863520c7))


### Bug Fixes

* **extract:** anchor the source-line guard to whole tokens and verify free text ([#159](https://github.com/cosmicspork/svastha/issues/159)) ([8b7d337](https://github.com/cosmicspork/svastha/commit/8b7d337d161cb20f86161381072a9ae969829f56))
* **node:** assemble transcript lines as visual rows ([#181](https://github.com/cosmicspork/svastha/issues/181)) ([bb8d784](https://github.com/cosmicspork/svastha/commit/bb8d784600376c8c78bd48f8ebb46b8a754c9b88))
* **node:** fold allergy and uncoded events into concepts like the web does ([#147](https://github.com/cosmicspork/svastha/issues/147)) ([2c41312](https://github.com/cosmicspork/svastha/commit/2c413127013129a700bf075adeb092f56c5cd2ef))
* **node:** scope reading pause to the owner who sent it ([#167](https://github.com/cosmicspork/svastha/issues/167)) ([3d8665f](https://github.com/cosmicspork/svastha/commit/3d8665f5c72a82af219c430c2656d298d1f4a4a7))
* **node:** tolerate malformed findings without erasing the page ([#166](https://github.com/cosmicspork/svastha/issues/166)) ([34feada](https://github.com/cosmicspork/svastha/commit/34feada82a92fa81965750bcd0ddc3453caac5c2))
* **relay:** namespace the mailbox store so it stops listing blobs ([#144](https://github.com/cosmicspork/svastha/issues/144)) ([5469790](https://github.com/cosmicspork/svastha/commit/5469790d73a9679bcf4bf6584671c17ba5fdbac1))
* **relay:** never panic building the batch cursor header ([#160](https://github.com/cosmicspork/svastha/issues/160)) ([186bfbf](https://github.com/cosmicspork/svastha/commit/186bfbfd3a12ae4c9d524b94fc37d1f2fe45bdf4))
* **retrieval:** one rendering and one tokenizer for node and browser ([#162](https://github.com/cosmicspork/svastha/issues/162)) ([2d03b73](https://github.com/cosmicspork/svastha/commit/2d03b7375c10739a9f158c9a1ec662555f371bee))
* **web:** band OCR rows on a median center, not the tallest run ([#158](https://github.com/cosmicspork/svastha/issues/158)) ([eb48fc5](https://github.com/cosmicspork/svastha/commit/eb48fc5c6daca956798b7efe6e1d9cb7846ee2e0))
* **web:** correct PDF text geometry, lifecycle, and error paths ([#163](https://github.com/cosmicspork/svastha/issues/163)) ([9d7fe94](https://github.com/cosmicspork/svastha/commit/9d7fe94a7b5d15368c15fbba014ba41af1b80e28))
* **web:** keep batch pulls from clobbering pushes, dropping pokes, and over-fetching ([#164](https://github.com/cosmicspork/svastha/issues/164)) ([782e42a](https://github.com/cosmicspork/svastha/commit/782e42af3d56c81cb86d3aa667c67bc9b13015a6))
* **web:** keep recently-logged labels beside long note text ([#165](https://github.com/cosmicspork/svastha/issues/165)) ([ae3b2d7](https://github.com/cosmicspork/svastha/commit/ae3b2d78e54570d44c5c67c2102e2a545f45f9c3))
* **web:** surface pull failures instead of stalling sync silently ([#143](https://github.com/cosmicspork/svastha/issues/143)) ([b7250bf](https://github.com/cosmicspork/svastha/commit/b7250bfbe4c218f1300cc10a13cd504df0235fda))
* **web:** vendor the tesseract cores the worker actually requests ([#161](https://github.com/cosmicspork/svastha/issues/161)) ([169fb05](https://github.com/cosmicspork/svastha/commit/169fb05d68020ee125453839c5bf098fe544f1a4))

## [0.13.0](https://github.com/cosmicspork/svastha/compare/v0.12.0...v0.13.0) (2026-07-27)


### Features

* **node:** split OCR and chat inference into per-role configs ([#134](https://github.com/cosmicspork/svastha/issues/134)) ([22288d8](https://github.com/cosmicspork/svastha/commit/22288d83d192cb4dc71a427d8182e4de612f5753))
* **web:** app-maintained back stack ([#132](https://github.com/cosmicspork/svastha/issues/132)) ([9ba2341](https://github.com/cosmicspork/svastha/commit/9ba2341d5464045796677db2128816c8ddd96b1a))
* **web:** dashboard glance cards (activity, vitals, symptoms, meds) ([#137](https://github.com/cosmicspork/svastha/issues/137)) ([31953f8](https://github.com/cosmicspork/svastha/commit/31953f8ca718b4de6f0d1d2c3b2e71f66e345855))
* **web:** fiddlehead mark for the app icon and unlock screen ([#142](https://github.com/cosmicspork/svastha/issues/142)) ([3196b46](https://github.com/cosmicspork/svastha/commit/3196b46eb84c546929005a24647479e6b17255e6))
* **web:** name SNOMED codes from the Global Patient Set dictionary ([#141](https://github.com/cosmicspork/svastha/issues/141)) ([7abe27f](https://github.com/cosmicspork/svastha/commit/7abe27fd93b497d09e8e0304a5a1e52ef118ff2a))
* **web:** search results expand in place (shared EventDetail) ([#136](https://github.com/cosmicspork/svastha/issues/136)) ([8195b42](https://github.com/cosmicspork/svastha/commit/8195b42f36f273b083764ba33c6e5378e6589f23))
* **web:** unify own & shared records into one RecordView ([#133](https://github.com/cosmicspork/svastha/issues/133)) ([0b5bdb3](https://github.com/cosmicspork/svastha/commit/0b5bdb31319386659d0e7ff7886bc79680d18485))


### Bug Fixes

* **web:** header icon hover bug + trim Today heading and swipe hint ([#131](https://github.com/cosmicspork/svastha/issues/131)) ([d03184c](https://github.com/cosmicspork/svastha/commit/d03184c4201774dbc2edc0711f181670d97e6863))
* **web:** restore enrolled-node detection and stop silent pull stalls ([#130](https://github.com/cosmicspork/svastha/issues/130)) ([b2ee891](https://github.com/cosmicspork/svastha/commit/b2ee891fe5cf7287f5673483ef3e987282dc01b6))

## [0.12.0](https://github.com/cosmicspork/svastha/compare/v0.11.0...v0.12.0) (2026-07-26)


### Features

* **web:** dashboard home, timeline/summary/search pages, consolidated sharing, and a round of PWA fixes ([#128](https://github.com/cosmicspork/svastha/issues/128)) ([2ebf77c](https://github.com/cosmicspork/svastha/commit/2ebf77c0c7ae0931cda28b4bde3565f5ac6d0ca8))

## [0.11.0](https://github.com/cosmicspork/svastha/compare/v0.10.0...v0.11.0) (2026-07-24)


### Features

* **core:** key epochs with mergeable keyrings and aad-bound markers ([#112](https://github.com/cosmicspork/svastha/issues/112)) ([296e30c](https://github.com/cosmicspork/svastha/commit/296e30c30bfa6fae03a71222b733d22b4515cf1f))
* **core:** typed mailbox envelope with signed kinds and message ids ([#110](https://github.com/cosmicspork/svastha/issues/110)) ([b67ecd1](https://github.com/cosmicspork/svastha/commit/b67ecd1514a0871e81659d1b03d9061a1c8a1de0))
* **node:** cited rag answers and admin command handling ([#121](https://github.com/cosmicspork/svastha/issues/121)) ([65d4d21](https://github.com/cosmicspork/svastha/commit/65d4d21e471a5594b458008cf9d86e8e805bc794))
* **node:** enrollment, sync, and curation-aware index substrate ([#114](https://github.com/cosmicspork/svastha/issues/114)) ([6c192b2](https://github.com/cosmicspork/svastha/commit/6c192b2f66eb016d98d8252bc1c4a2dc97de1a60))
* **node:** OCR captured pages into proposal envelopes ([#118](https://github.com/cosmicspork/svastha/issues/118)) ([d09cd10](https://github.com/cosmicspork/svastha/commit/d09cd10fcdd316bbb9cfbe0fc432d77e322eff64))
* **relay:** cursor pagination and curation etags ([#119](https://github.com/cosmicspork/svastha/issues/119)) ([df647fb](https://github.com/cosmicspork/svastha/commit/df647fb98ae55e541df0d04e2c9b4f53b9488e7d))
* **relay:** prefix-scoped grants with optional expiry ([#111](https://github.com/cosmicspork/svastha/issues/111)) ([4d54e60](https://github.com/cosmicspork/svastha/commit/4d54e60a50af3355493c9de4d26183c2dd72b420))
* **relay:** sse push channel and auth nonce store ([#109](https://github.com/cosmicspork/svastha/issues/109)) ([5542ae0](https://github.com/cosmicspork/svastha/commit/5542ae0eb75902a1e406406d288074f199f7d9b0))
* **relay:** web push subscriptions and poke fan-out ([#117](https://github.com/cosmicspork/svastha/issues/117)) ([709fc8a](https://github.com/cosmicspork/svastha/commit/709fc8a5147dd4c89ba3f06fa071a9018854e6bf))
* **share:** cross-device share management and history clearing ([#125](https://github.com/cosmicspork/svastha/issues/125)) ([5b23c82](https://github.com/cosmicspork/svastha/commit/5b23c827e9edddb92f24eb476ca9173738160363))
* **web:** ask screen, node admin, and SSE push client ([#115](https://github.com/cosmicspork/svastha/issues/115)) ([e09b9e1](https://github.com/cosmicspork/svastha/commit/e09b9e12c8c90b589cd653269d8a38a739c3006a))
* **web:** devices and grants screen with revoke-and-rotate ([#116](https://github.com/cosmicspork/svastha/issues/116)) ([c41acc3](https://github.com/cosmicspork/svastha/commit/c41acc34af325bbd78a37f5c380abbe4940c0573))
* **web:** include doc- blobs in doctor-share bundles ([#108](https://github.com/cosmicspork/svastha/issues/108)) ([b503ad9](https://github.com/cosmicspork/svastha/commit/b503ad9e0d0752f6ed846ea4477fd2639b026f87))
* **web:** pdf attachments in paper-record capture ([#104](https://github.com/cosmicspork/svastha/issues/104)) ([f6b915c](https://github.com/cosmicspork/svastha/commit/f6b915c5732a46232398551cc353ed476ea2dfbd))
* **web:** proposal inbox with provenance review and batch approval ([#113](https://github.com/cosmicspork/svastha/issues/113)) ([1647e3d](https://github.com/cosmicspork/svastha/commit/1647e3dd3584f7f600bd3184fc5fb86ee5bf1d55))
* **web:** relay-less file share with optional passphrase ([#124](https://github.com/cosmicspork/svastha/issues/124)) ([8409a63](https://github.com/cosmicspork/svastha/commit/8409a63ffafc6408a5f8080039ae481bb5bb6273))
* **web:** service worker push handler and notification settings ([#120](https://github.com/cosmicspork/svastha/issues/120)) ([d3562bd](https://github.com/cosmicspork/svastha/commit/d3562bdb4cd49499d9c3001e3c0996578938dfae))


### Bug Fixes

* **web:** neutral person language in grant and ask copy ([#127](https://github.com/cosmicspork/svastha/issues/127)) ([935a56e](https://github.com/cosmicspork/svastha/commit/935a56e9c192f47717f51dfb897189cc89b40859))

## [0.10.0](https://github.com/cosmicspork/svastha/compare/v0.9.0...v0.10.0) (2026-07-22)


### Features

* **web:** manual bloom petal order and UI polish ([#101](https://github.com/cosmicspork/svastha/issues/101)) ([816d633](https://github.com/cosmicspork/svastha/commit/816d633476ae4185664536e862174a678b70fe1c))

## [0.9.0](https://github.com/cosmicspork/svastha/compare/v0.8.0...v0.9.0) (2026-07-22)


### Features

* **core:** signed curation records ([#97](https://github.com/cosmicspork/svastha/issues/97)) ([f1e0273](https://github.com/cosmicspork/svastha/commit/f1e0273a1e3943aebc62bc954cb384dfa4998856))
* **web:** app header with notification center ([#92](https://github.com/cosmicspork/svastha/issues/92)) ([2762316](https://github.com/cosmicspork/svastha/commit/2762316196c5d1d0d032f4bca1004ff1eea142aa))
* **web:** bloom shows top actions with More overflow sheet ([#91](https://github.com/cosmicspork/svastha/issues/91)) ([2307025](https://github.com/cosmicspork/svastha/commit/2307025632d5d55c7b2e89e45a45f49ab902f348))
* **web:** carry signed curation in doctor-share bundles ([#100](https://github.com/cosmicspork/svastha/issues/100)) ([3febc03](https://github.com/cosmicspork/svastha/commit/3febc03dbfde4e31e7f03ba03b49935b74376ea2))
* **web:** loinc top-2000 ingestion for the code dictionary ([#90](https://github.com/cosmicspork/svastha/issues/90)) ([2d41d00](https://github.com/cosmicspork/svastha/commit/2d41d00f9db9aba6e964990715f58b23c546b2f4))
* **web:** name-first summary rows with demoted codes ([#86](https://github.com/cosmicspork/svastha/issues/86)) ([94a3d52](https://github.com/cosmicspork/svastha/commit/94a3d52438d6be93380ed0ce4b5b28d5044fb2cf))
* **web:** settings hub with five sub-screens ([#93](https://github.com/cosmicspork/svastha/issues/93)) ([d6f60f4](https://github.com/cosmicspork/svastha/commit/d6f60f45901764dc52fcd40afe968409d3483b49))
* **web:** sharing split by audience with in-app QR scanning ([#95](https://github.com/cosmicspork/svastha/issues/95)) ([a648bf7](https://github.com/cosmicspork/svastha/commit/a648bf751969ae915406076c4e7e2686899242da))
* **web:** signed curation with med and problem status ([#99](https://github.com/cosmicspork/svastha/issues/99)) ([acb1cb6](https://github.com/cosmicspork/svastha/commit/acb1cb6ef21fdf5bcd8d81bbf13b19c59a4e3612))
* **web:** update prompt with release notes and relaunch ([#94](https://github.com/cosmicspork/svastha/issues/94)) ([d2e2562](https://github.com/cosmicspork/svastha/commit/d2e256241370883a3c483427d24e45e71c94fd94))


### Bug Fixes

* **web:** distinct scan-frame glyph for paper record petal ([#85](https://github.com/cosmicspork/svastha/issues/85)) ([0631cd8](https://github.com/cosmicspork/svastha/commit/0631cd8d42e342cfac5c6a1c392e4e9908a76215))
* **web:** settings-nav e2e helpers and shared-timeline pull race ([#98](https://github.com/cosmicspork/svastha/issues/98)) ([c3b5097](https://github.com/cosmicspork/svastha/commit/c3b5097b67e04b991e82cce90d4b3f8cee6baad7))
* **web:** verify and resume code dictionary downloads ([#88](https://github.com/cosmicspork/svastha/issues/88)) ([80aef5d](https://github.com/cosmicspork/svastha/commit/80aef5dca3c51c8a422c446a1baa9ef3f248e734))
* **web:** wrap sharing QR in an app deep link ([#89](https://github.com/cosmicspork/svastha/issues/89)) ([14e5d02](https://github.com/cosmicspork/svastha/commit/14e5d0204e5212ede59d452e770540000d6edd9b))

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
