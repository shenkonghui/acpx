TSX := node_modules/.bin/tsx
CHAT_SERVER := examples/acp-chat/server.ts
PORT ?= 4174

.DEFAULT_GOAL := help
.PHONY: help web web-open web-status web-stop web-build web-typecheck

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

web: ## Start the acp-chat web page in the foreground (Ctrl-C to stop); PORT=xxxx to override
	$(TSX) $(CHAT_SERVER) start --port $(PORT)

web-open: ## Start acp-chat and open it in a browser
	$(TSX) $(CHAT_SERVER) start --port $(PORT) --open

web-status: ## Print whether acp-chat is running and its settings
	$(TSX) $(CHAT_SERVER) status --port $(PORT)

web-stop: ## Stop a running acp-chat instance
	$(TSX) $(CHAT_SERVER) stop --port $(PORT)

web-build: ## Build the acp-chat frontend into examples/acp-chat/dist
	node_modules/.bin/vite build --config examples/acp-chat/vite.config.ts

web-typecheck: ## Typecheck the acp-chat app and server
	node_modules/.bin/tsc -p examples/acp-chat/tsconfig.json --noEmit && node_modules/.bin/tsc -p examples/acp-chat/tsconfig.server.json --noEmit
