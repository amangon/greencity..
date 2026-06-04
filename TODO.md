# TODO

## Step 1: Replace better-sqlite3 with pure-JS SQLite
- [ ] Update `package.json` dependencies (remove `better-sqlite3`, add `sql.js` or another pure-JS sqlite library)
- [ ] Patch `server.js` to use the new DB layer
- [ ] Ensure all existing SQL schema/table creation and queries work

## Step 2: Verify server + pages
- [ ] Run `npm install`
- [ ] Run `npm start`
- [ ] Verify `/` and `/admin.html` return 200
- [ ] Verify at least one API endpoint works (health check or auth/register)

