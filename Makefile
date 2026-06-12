SHELL := /bin/bash
COMPOSE := docker compose
PROJECT := crypto-screener
COMPOSE_FILE := -f compose.yaml -p $(PROJECT)

.PHONY: help require_compose_v2 up down restart build pull ps logs logs-server logs-client exec-server exec-postgres exec-redis shell-server shell-client config bootstrap clean prune reset

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

require_compose_v2:
	@command -v docker >/dev/null 2>&1 || { \
	  echo >&2 "\033[31mdocker not installed\033[0m — run \033[36mmake bootstrap\033[0m"; exit 1; }
	@docker compose version >/dev/null 2>&1 || { \
	  echo >&2 "\033[31mCompose V2 plugin missing\033[0m"; \
	  echo >&2 "  Install: \033[36m./scripts/install-compose-v2.sh\033[0m"; \
	  echo >&2 "  Full setup + bring up: \033[36mmake bootstrap\033[0m"; \
	  echo >&2 "  Legacy patch (NOT recommended): \033[36m./scripts/v1-hotfix.sh\033[0m"; \
	  exit 2; }

up: require_compose_v2 ## Build & start all services
	$(COMPOSE) $(COMPOSE_FILE) up -d --build

down: require_compose_v2 ## Stop & remove all containers (volumes preserved)
	$(COMPOSE) $(COMPOSE_FILE) down --remove-orphans

restart: require_compose_v2 ## Recreate containers
	$(COMPOSE) $(COMPOSE_FILE) up -d --force-recreate --build

build: require_compose_v2 ## Build images only
	$(COMPOSE) $(COMPOSE_FILE) build

pull: require_compose_v2 ## Pull base images
	$(COMPOSE) $(COMPOSE_FILE) pull --ignore-pull-failures

ps: require_compose_v2 ## List running services
	$(COMPOSE) $(COMPOSE_FILE) ps

logs: require_compose_v2 ## Tail all logs
	$(COMPOSE) $(COMPOSE_FILE) logs -f --tail=200

logs-server: require_compose_v2 ## Tail server logs
	$(COMPOSE) $(COMPOSE_FILE) logs -f --tail=200 server

logs-client: require_compose_v2 ## Tail client logs
	$(COMPOSE) $(COMPOSE_FILE) logs -f --tail=200 client

exec-server: require_compose_v2 ## Open shell into server container
	$(COMPOSE) $(COMPOSE_FILE) exec server sh

shell-server: exec-server

shell-client: require_compose_v2 ## Open shell into client container
	$(COMPOSE) $(COMPOSE_FILE) exec client sh

exec-postgres: require_compose_v2 ## Open psql shell
	$(COMPOSE) $(COMPOSE_FILE) exec postgres psql -U screener -d cryptoscreener

exec-redis: require_compose_v2 ## Open redis-cli shell
	$(COMPOSE) $(COMPOSE_FILE) exec redis redis-cli

config: require_compose_v2 ## Validate & render compose config
	$(COMPOSE) $(COMPOSE_FILE) config

bootstrap: ## Install Docker + Compose V2 plugin + bring up (Linux root/sudo)
	@bash scripts/bootstrap.sh

clean: require_compose_v2 ## Stop containers, remove images built by this project
	$(COMPOSE) $(COMPOSE_FILE) down --remove-orphans --rmi local

prune: require_compose_v2 ## Aggressive prune (containers, networks, dangling images); keeps volumes
	docker container prune -f && docker network prune -f && docker image prune -f

reset: require_compose_v2 ## DANGER: stop stack and DELETE pgdata + redisdata volumes
	$(COMPOSE) $(COMPOSE_FILE) down --remove-orphans -v
