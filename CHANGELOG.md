# Changelog

## [0.2.0](https://github.com/Celeste-inc/celeste-hyper/compare/v0.1.0...v0.2.0) (2026-07-02)


### Features

* **api:** wire new routes, deps and shared schemas ([e0d2e44](https://github.com/Celeste-inc/celeste-hyper/commit/e0d2e446950b6a16efba28302b611784db784640))
* **cli:** --version and --help argv handlers ([36bdb53](https://github.com/Celeste-inc/celeste-hyper/commit/36bdb53b1127c008eeb4fcf30e30d3c974705364))
* **cli:** add offline state CLI for backup, restore, and migrate ([fe46cf1](https://github.com/Celeste-inc/celeste-hyper/commit/fe46cf11e5d6ce9c9f5f7a9e48bb1acfe192cf61))
* **cluster:** add support to cluster master and clients connection ([3996c53](https://github.com/Celeste-inc/celeste-hyper/commit/3996c537b59915c077726062427a36bf2bebc754))
* **config:** add config schema example and Docker variant ([d02e500](https://github.com/Celeste-inc/celeste-hyper/commit/d02e500d77de0a3b886e70deab1e9952d2094c8b))
* **deploy-stream:** live SSE stream of deployment status transitions ([81ccbc9](https://github.com/Celeste-inc/celeste-hyper/commit/81ccbc9d88437ce801b2476abcc264794eae4e00))
* **deploy:** add curl-pipeable bootstrap installer for one-line install and update ([6950c17](https://github.com/Celeste-inc/celeste-hyper/commit/6950c1721176b25e5bf94f4409f43def58b94ed4))
* **deploy:** add systemd unit and install script for VM rollout ([9f9e436](https://github.com/Celeste-inc/celeste-hyper/commit/9f9e436eee9f0a08615c6670d99f12ba09a41d88))
* **deploy:** update.sh — safe in-place upgrade with auto-rollback ([110bbbb](https://github.com/Celeste-inc/celeste-hyper/commit/110bbbb15b5a4486797dc20e7baf8ebed0c12acc))
* **docker:** add runtime image, test image, and multi-cluster compose stack ([734d691](https://github.com/Celeste-inc/celeste-hyper/commit/734d69126aa55b187da20356fd0166d770a0f061))
* **env:** redeploy after update env ([bc05b65](https://github.com/Celeste-inc/celeste-hyper/commit/bc05b6513bf627bbb22380b3529afc58d697f5ac))
* **fleet:** multi-cluster federation overview ([60ce9e2](https://github.com/Celeste-inc/celeste-hyper/commit/60ce9e2afdb70098e016129877b839bf06fff3b9))
* **frontend:** add React UI with screens, components, and shared API client ([2f215ac](https://github.com/Celeste-inc/celeste-hyper/commit/2f215ace24bc0718e7b1eb48a4c602e4f63e3079))
* **frontend:** add Vite, TypeScript, and Vitest config ([6ab93de](https://github.com/Celeste-inc/celeste-hyper/commit/6ab93deda5518db82f6aca94272a9ceb73e5b68f))
* **lib:** add shared libraries for state, k8s, r2, auth, helm, and git ([92c72fa](https://github.com/Celeste-inc/celeste-hyper/commit/92c72fa7d5a1c4b44aa87ff5f220b950b3913324))
* **metrics:** live pod CPU/RAM panel via metrics-server ([0b8a27b](https://github.com/Celeste-inc/celeste-hyper/commit/0b8a27b4e0e041473d9103a64a2cd2a5600d90fc))
* **networking:** externalIPs escape hatch + friendlier NodePort error ([bf681be](https://github.com/Celeste-inc/celeste-hyper/commit/bf681be4bf02a2f564835fd2e976f6737c80c6b9))
* **networking:** in-place Service port/type patch (no recreation) ([63d664c](https://github.com/Celeste-inc/celeste-hyper/commit/63d664c05b0f1b9609fbada714c37bebb90ddd0b))
* **pod-ops:** per-pod delete + workload redeploy ([255ca4d](https://github.com/Celeste-inc/celeste-hyper/commit/255ca4d5bde260ba2ba5dcd99097da20c0e0fc8e))
* **ports:** port manager with native-LB conflict resolution ([6c9e939](https://github.com/Celeste-inc/celeste-hyper/commit/6c9e939fe39b771c74cf6a7c59787e0858c80a1e))
* **purge:** full service teardown with confirmation modal ([f58e587](https://github.com/Celeste-inc/celeste-hyper/commit/f58e58779ff7cdcb68eea5e2c753a1c42596352e))
* **queue:** add durable job queue with deploy, rollback, and helm-upgrade handlers ([bd45ad2](https://github.com/Celeste-inc/celeste-hyper/commit/bd45ad20add52da034446378a97589af54b75019))
* **registries:** connection test via OCI Registry v2 token flow ([c4b25b0](https://github.com/Celeste-inc/celeste-hyper/commit/c4b25b021b07bf065dbb13098afd9787630081a2))
* **registries:** container registry presets + pull-secret provisioning ([b6985ca](https://github.com/Celeste-inc/celeste-hyper/commit/b6985cadc784489e1a2c7ddd90647e76e99cbda2))
* **registry-sources:** persistent registry credentials (R2-style) ([914de18](https://github.com/Celeste-inc/celeste-hyper/commit/914de18c2e9d4173efe3dfe5204c5ae32d5d2703))
* **routes:** add Elysia HTTP routes with auth, services, deploys, logs, and SSE ([c7a1366](https://github.com/Celeste-inc/celeste-hyper/commit/c7a13664353370094b2a0f2ab7186020325c614e))
* **scaling:** API endpoints ([3391bdf](https://github.com/Celeste-inc/celeste-hyper/commit/3391bdf6f06c49d5e65c521080fae2b020ff399a))
* **scaling:** online PVC expand patch builder ([9c77b13](https://github.com/Celeste-inc/celeste-hyper/commit/9c77b135a736c61f0b2d9589f55c2634cd941fff))
* **scaling:** vertical resources patch with production caps ([e3fdbb9](https://github.com/Celeste-inc/celeste-hyper/commit/e3fdbb97543c662466c984b41b3bd1ce1dc22775))
* **scaling:** workload capability classifier ([c516ff6](https://github.com/Celeste-inc/celeste-hyper/commit/c516ff6bc9c0f85f230258944b7e3a56ca2d33bb))
* **server:** add Bun/Elysia bootstrap, config loader, and version ([93d981d](https://github.com/Celeste-inc/celeste-hyper/commit/93d981d559742a6c69f67884789fe199e359f7fb))
* **services:** add registry, deployer, poller, and capability probe ([6e33844](https://github.com/Celeste-inc/celeste-hyper/commit/6e338445dc619a955d4cede0a522fd6f6165b2e4))
* **services:** group workers as subgroups under the parent service ([5cddea9](https://github.com/Celeste-inc/celeste-hyper/commit/5cddea95e9bd45314e0b456ee1cc0dee0a81901c))
* **slo:** per-service SLO digest ([14a39e2](https://github.com/Celeste-inc/celeste-hyper/commit/14a39e2610a84f41531337646fc88531cfe4dfdc))
* **templates:** deploy arbitrary Docker Hub images + lifecycle namespace ([8e9375f](https://github.com/Celeste-inc/celeste-hyper/commit/8e9375fd9f2b818707d320a53a0443497c6396e3))
* **templates:** public-image catalog + one-click deploy ([0f609a7](https://github.com/Celeste-inc/celeste-hyper/commit/0f609a78edef4a642b47d8d63f25dab71465039b))
* **ui-networking:** real external IP suggestions from the cluster ([370f184](https://github.com/Celeste-inc/celeste-hyper/commit/370f1840b6c5c894dd89ff8f3f93d1513d5017bc))
* **ui-status:** pending vs error tone helper ([cc57249](https://github.com/Celeste-inc/celeste-hyper/commit/cc5724957b09d08be9f06eeea245e1bafaf7bff9))
* **ui:** pod tracker + redeploy + Deploy from Docker Hub search ([6c7a9fd](https://github.com/Celeste-inc/celeste-hyper/commit/6c7a9fd9292dcb0368fbf1960305ae76cfeefb87))
* **ui:** Runtime reorder + DeletePod modal + registry test buttons ([c8da2da](https://github.com/Celeste-inc/celeste-hyper/commit/c8da2dac274b307084c9f3daf7594fd60d1bd77d))
* **ui:** scaling modal — vertical + online PVC expand ([8d174f2](https://github.com/Celeste-inc/celeste-hyper/commit/8d174f22e665d8519c87f79bc54951aa1a57c4d6))
* **ui:** wire modals, panels and status pills ([3221f0e](https://github.com/Celeste-inc/celeste-hyper/commit/3221f0e8ee0da04c212b431928164b06f276e635))
* **yaml:** minimal YAML 1.2 stringifier for k8s manifests ([f4a0d4a](https://github.com/Celeste-inc/celeste-hyper/commit/f4a0d4aaa20c3c02d9e17f8d446c9be2db05cf05))


### Bug Fixes

* **capabilities:** self-heal helm + metrics-server checks ([41ef288](https://github.com/Celeste-inc/celeste-hyper/commit/41ef288815de8f76649411db1756f6ffc7476815))
* **ci:** switch dependabot frontend and root ecosystems to bun so bun.lock stays in sync ([420be2a](https://github.com/Celeste-inc/celeste-hyper/commit/420be2a14d4228854cfcd68eb4b0afa220708294))
* **deploy/update:** log to stderr, never probe the running binary ([64f4c8d](https://github.com/Celeste-inc/celeste-hyper/commit/64f4c8df3b7d6746c388f3ea885f07ec6866de36))
* **deploy:** symlink bunx alongside bun so frontend build works under sudo ([49a09b3](https://github.com/Celeste-inc/celeste-hyper/commit/49a09b37b77fd0d57c06344b10cdbc79f128d03e))
* **docs:** repair mermaid diagrams broken by HTML entities and ambiguous edge labels ([18639ff](https://github.com/Celeste-inc/celeste-hyper/commit/18639ff747d76189ad97db4f17fd316a43d56b85))
* **exec:** decode stdout bytes to UTF-8 before sending ([c74a50b](https://github.com/Celeste-inc/celeste-hyper/commit/c74a50b54694d3563ec4306faad2882a119f5cba))
* **exec:** interactive web shell actually works ([8f62386](https://github.com/Celeste-inc/celeste-hyper/commit/8f62386cc116722ec3b7c4443d1cfb674342aa99))
* **frontend:** add Vite client type reference so CSS side-effect imports typecheck under TypeScript 6 ([4905ca8](https://github.com/Celeste-inc/celeste-hyper/commit/4905ca83e21b789e53a9b3f66b8853b222e4221b))
* loading ([300a147](https://github.com/Celeste-inc/celeste-hyper/commit/300a14725dc88a97706c6626e095807e780bbf49))
* **pod-delete:** snappy default + --force escape hatch ([184d642](https://github.com/Celeste-inc/celeste-hyper/commit/184d642fa9598628eca93d291d3a436854f074f2))


### Documentation

* add architecture, operations, clusters, sources, frontend, api, and local-stack guides ([a7b4bf2](https://github.com/Celeste-inc/celeste-hyper/commit/a7b4bf22c9419f552b86fabef9e314a2af9b8684))
* **readme:** add project README with quickstart, bundle convention, and API summary ([7a12f4b](https://github.com/Celeste-inc/celeste-hyper/commit/7a12f4b36e10d608c4a02baeae0ebc0aa91ae2c3))
* **readme:** collapse to install-first format with links to docs/ ([b71d0b0](https://github.com/Celeste-inc/celeste-hyper/commit/b71d0b022f2bd1fca2b1c76088c0456f7e2e54ce))
