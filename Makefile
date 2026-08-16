# pi-hindsight — dev / global mode toggle
#
# This repo can run in two modes:
#   dev    — load the LOCAL working-tree source via .pi/extensions/hindsight.ts
#            (default). The globally-installed npm copy self-stands-down here
#            (see the mode guard in src/index.ts), so only your dev code runs.
#   global — disable the local loader so the globally-installed published
#            package (`pi install npm:@abix5/pi-hindsight`) loads instead,
#            letting you test exactly what users get.
#
# After switching, run /reload in pi (or restart pi) to apply.

LOADER   := .pi/extensions/hindsight.ts
DISABLED := .pi/extensions/hindsight.ts.disabled

.PHONY: help dev global status install-global remove-global check publish

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

dev: ## Load the local working-tree source in this repo (default)
	@if [ -f "$(DISABLED)" ]; then mv "$(DISABLED)" "$(LOADER)"; fi
	@echo "mode: DEV — local loader active ($(LOADER)). Run /reload in pi."

global: ## Use the globally-installed npm package (disable the local loader)
	@if [ -f "$(LOADER)" ]; then mv "$(LOADER)" "$(DISABLED)"; fi
	@echo "mode: GLOBAL — local loader disabled; npm @abix5/pi-hindsight loads. Run /reload in pi."

status: ## Show the current mode
	@if [ -f "$(LOADER)" ]; then echo "mode: DEV (local loader present)"; \
	 else echo "mode: GLOBAL (local loader disabled)"; fi

install-global: ## Register the published package globally for all projects
	pi install npm:@abix5/pi-hindsight

remove-global: ## Unregister the published package
	pi remove npm:@abix5/pi-hindsight

check: ## Typecheck + run the self-tests
	npx tsc --noEmit
	bun scripts/config-merge.test.ts
	bun scripts/review-queue.test.ts
	bun scripts/model-chain.test.ts
	bun scripts/mem-panel.test.ts
	bun scripts/recall-judge.test.ts
	bun scripts/task-detector.test.ts
	bun scripts/turn-recall.test.ts
	bun scripts/bank-reminder.test.ts
	bun scripts/fact-invalidation.test.ts
	bun scripts/widget.test.ts
	bun scripts/write-hygiene.test.ts
	bun scripts/user-bank.test.ts
	bun scripts/user-bank-context.test.ts
	bun scripts/memorize-user-bank.test.ts
	bun scripts/user-block-epoch.test.ts
	bun scripts/user-block-marker.test.ts
	bun scripts/user-block-widget.test.ts
	bun scripts/delta-window.test.ts
	bun scripts/restore-killed-fact.test.ts
	npm test

publish: check ## Typecheck, then publish to npm (needs auth)
	npm publish
