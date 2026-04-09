.PHONY: anvil deploy-local backend frontend db mysql dev dev-fresh dev-contracts dev-contracts-fresh dev-apps dev-split stack-contracts stack-apps

anvil:
	node scripts/anvil.js

deploy-local:
	node scripts/deploy-local.js

backend:
	npm --prefix backend run dev

frontend:
	node scripts/frontend-dev.js

db:
	node scripts/db-up.js

mysql:
	node scripts/mysql-up.js

dev:
	node scripts/dev.js

dev-fresh:
	node scripts/dev.js --fresh

dev-contracts:
	node scripts/dev.js --contracts-only

dev-contracts-fresh:
	node scripts/dev.js --contracts-only --fresh

dev-apps:
	node scripts/dev.js --apps-only

dev-split:
	npm run dev:contracts:fresh && npm run dev:apps

stack-contracts:
	npm run stack:contracts

stack-apps:
	npm run stack:apps
