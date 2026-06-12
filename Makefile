SHELL := /bin/bash
COMPOSE := docker compose
PROJECT := crypto-screener
COMPOSE_FILE := -f compose.yaml -p $(PROJECT)

.PHONY: help up down restart build pull ps logs logs-server logs-client exec-server exec-postgres exec-redis shell-server shell-client config clean prune reset

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

up: ## Build & start all services
	$(COMPOSE) $(COMPOSE_FILE) up -d --build

down: ## Stop & remove all containers (volumes preserved)
	$(COMPOSE) $(COMPOSE_FILE) down --remove-orphans

restart: ## Recreate containers
	$(COMPOSE) $(COMPOSE_FILE) up -d --force-recreate --build

build: ## Build images only
	$(COMPOSE) $(COMPOSE_FILE) build

pull: ## Pull base images
	$(COMPOSE) $(COMPOSE_FILE) pull --ignore-pull-failures

ps: ## List running services
	$(COMPOSE) $(COMPOSE_FILE) ps

logs: ## Tail all logs
	$(COMPOSE) $(COMPOSE_FILE) logs -f --tail=200

logs-server: ## Tail server logs
	$(COMPOSE) $(COMPOSE_FILE) logs -f --tail=200 server

logs-client: ## Tail client logs
	$(COMPOSE) $(COMPOSE_FILE) logs -f --tail=200 client

exec-server: ## Open shell into server container
	$(COMPOSE) $(COMPOSE_FILE) exec server sh

shell-server: exec-server

shell-client: ## Open shell into client container
	$(COMPOSE) $(COMPOSE_FILE) exec client sh

exec-postgres: ## Open psql shell
	$(COMPOSE) $(COMPOSE_FILE) exec postgres psql -U screener -d cryptoscreener

exec-redis: ## Open redis-cli shell
	$(COMPOSE) $(COMPOSE_FILE) exec redis redis-cli

config: ## Validate & render compose config
	$(COMPOSE) $(COMPOSE_FILE) config

clean: ## Stop containers, remove images built by this project
	$(COMPOSE) $(COMPOSE_FILE) down --remove-orphans --rmi local

prune: ## Aggressive prune (containers, networks, dangling images); keeps volumes
	docker container prune -f && docker network prune -f && docker image prune -f

reset: ## DANGER: stop stack and DELETE pgdata + redisdata volumes
	$(COMPOSE) $(COMPOSE_FILE) down --remove-orphans -v
