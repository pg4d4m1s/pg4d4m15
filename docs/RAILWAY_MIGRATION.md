# PGA-DAMIS: Railway Account Migration Reference

Migration performed **Nov 7-8, 2026**: moved the production deployment (code, SQLite data, and domain) from the old Railway/GitHub account to a new one to start a fresh free trial.

> No secrets or account emails are stored in this file. Variable values live only in Railway's Variables tab and in a private local backup outside the repo.

---

## 1. Before and after

| | Old | New |
|---|---|---|
| GitHub repo | `pgadamis2/damis` | `pgadamis3/pga-damis` |
| Railway project | `amused-tenderness` | `noble-truth` |
| Service | `damis` | `pga-damis` |
| Volume | `damis-volume` at `/data` | `pga-damis-volume` at `/data` |
| Domain | `damis.up.railway.app` | `damis.up.railway.app` (moved over) |
| App port | `PORT=3000` | `PORT=3000` |

## 2. Where things live

- **Code**: GitHub repo (deployed by Railway on push).
- **Live databases**: SQLite files on the Railway volume at `/data` (`DATA_DIR=/data`):
  - `connecthub.db` (main app DB, about 942 KB, **WAL mode**; sessions are stored in it too)
  - `db_archives_registry.db` (about 16 KB, list of semester archives)
- **Semester archives**: stored in the cloud and cached locally on demand (the app logs `cached cloud snapshot`). Only the registry lives on the volume.
- **Secrets / config**: Railway service Variables. They do **not** transfer between projects and must be re-entered.

## 3. What was done (in order)

### 3.1 Move the code
```bash
cd ~/PGADAIMS/DAMIS
git remote set-url origin https://github.com/pgadamis3/pga-damis.git
git push -u origin main
```
HTTPS push used the new account's username and a personal access token as the password.

### 3.2 Install the CLI and inspect the old volume
```bash
npm i -g @railway/cli
railway login                      # OLD account
railway link                       # old project / production / damis service
railway volume list                # shows mount path /data
railway ssh -- "ls -la /data"
```

### 3.3 Back up the databases (consistent snapshot)
The container has `python3` but **no `sqlite3` binary**, so the snapshot uses Python's SQLite backup API. It produces one merged file even while the app is running and writing.

```bash
cd ~/PGADAIMS/DAMIS     # must be the folder where `railway link` was run
railway ssh -- "python3 -c \"import sqlite3; s=sqlite3.connect('/data/connecthub.db'); d=sqlite3.connect('/tmp/connecthub_snap.db'); s.backup(d); d.close(); s.close()\" && base64 /tmp/connecthub_snap.db" | base64 -d > ~/PGADAIMS/connecthub_snap.db

railway ssh -- "python3 -c \"import sqlite3; s=sqlite3.connect('/data/db_archives_registry.db'); d=sqlite3.connect('/tmp/registry_snap.db'); s.backup(d); d.close(); s.close()\" && base64 /tmp/registry_snap.db" | base64 -d > ~/PGADAIMS/db_archives_registry_snap.db

sqlite3 ~/PGADAIMS/connecthub_snap.db "PRAGMA integrity_check;"   # expect: ok
```
Backup copies kept in `~/PGADAIMS/`: `connecthub_snap.db`, `connecthub_FINAL_backup.db`, `connecthub_backup.sql`, `db_archives_registry_snap.db`. **Keep these out of git.**

A first attempt with `tar` was abandoned: tar warned `file changed as we read it`, and the WAL/SHM copies were inconsistent.

### 3.4 Save the old environment variables
```bash
railway variables --kv > ~/PGADAIMS/old_env_vars.txt
chmod 600 ~/PGADAIMS/old_env_vars.txt
grep -v '^RAILWAY_' ~/PGADAIMS/old_env_vars.txt > ~/PGADAIMS/new_env_vars.txt
```
Do **not** `cat` this file (it prints every secret). The `RAILWAY_*` lines are generated per project and are dropped.

### 3.5 Create the new project
1. Log in to Railway with the new GitHub account.
2. New Project, Deploy from GitHub repo, `pga-damis`.
3. Attach a volume to the service, mount path `/data`.
4. Variables, Raw Editor: paste `new_env_vars.txt`.
5. Let it deploy once so a container exists (this creates blank DBs on the volume).

### 3.6 Use a separate SSH key for the new account
Railway allows a key to be registered to **one account only**. The original key belongs to the old account, so the new account got its own:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_railway -N ""
railway ssh keys add -k ~/.ssh/id_ed25519_railway.pub -n kali-new
railway ssh -i ~/.ssh/id_ed25519_railway -- "ls -la /data"     # new account: use -i
```
Old account keeps using the default key (`~/.ssh/id_ed25519`).

### 3.7 Upload, verify, swap, restart
The app already had blank DBs open, so the files were **not** overwritten in place:
```bash
cd ~/PGADAIMS/DAMIS
base64 ~/PGADAIMS/connecthub_snap.db | railway ssh -i ~/.ssh/id_ed25519_railway -- "base64 -d > /data/connecthub.db.new"
base64 ~/PGADAIMS/db_archives_registry_snap.db | railway ssh -i ~/.ssh/id_ed25519_railway -- "base64 -d > /data/db_archives_registry.db.new"

# verify the uploaded copy BEFORE swapping
railway ssh -i ~/.ssh/id_ed25519_railway -- "python3 -c \"import sqlite3; c=sqlite3.connect('file:/data/connecthub.db.new?mode=ro', uri=True); print(c.execute('pragma integrity_check').fetchone(), c.execute('select count(*) from admin_logs').fetchone(), c.execute('select count(*) from users').fetchone())\""

# swap (remove blank DBs' WAL/SHM, rename the real ones into place)
railway ssh -i ~/.ssh/id_ed25519_railway -- "cd /data && rm -f connecthub.db-wal connecthub.db-shm db_archives_registry.db-wal db_archives_registry.db-shm && mv -f connecthub.db.new connecthub.db && mv -f db_archives_registry.db.new db_archives_registry.db && ls -la"

# clean up sidecar files the verification step created
railway ssh -i ~/.ssh/id_ed25519_railway -- "rm -f /data/connecthub.db.new-shm /data/connecthub.db.new-wal"
```
Then **Redeploy/Restart** the service in the dashboard so the app drops its old file handles and opens the real database.

### 3.8 Move the domain
1. Old service: Settings, Networking, remove `damis.up.railway.app`.
2. New service: Settings, Networking, add `damis` (generates `damis.up.railway.app`).
3. Set the domain's **target port to 3000** (the app's `PORT`). A mismatch causes `502 Bad Gateway`.
4. `APP_URL` and `GOOGLE_CALLBACK_URL` already pointed at this domain, so the Google OAuth redirect URI needed no change.

## 4. Verification results

- Snapshot and uploaded copy: `integrity_check` = `ok`, `admin_logs` = **360** rows, live `users` = **5**.
- Startup log after the restart: server listening on port 3000, sessions using the SQLite store at `/data/connecthub.db`, all 5 admin seed slots reported `already exists` (proof the real DB loaded, not a blank one), Cloudinary, Google OAuth, and email chain configured.
- Admin panel served users, dormitory rooms, billing, and archive data.

## 5. Gotchas and lessons

1. **`railway link` is per folder.** Run CLI commands from `~/PGADAIMS/DAMIS`. From any other folder you get `No linked project found`.
2. **CLI login decides which account you touch.** Check with `railway whoami` before any command. Logging out and back in is required to switch accounts.
3. **One SSH key per Railway account.** Use `railway ssh -i <key>` for the second account.
4. **`cmd | base64 -d > file` overwrites the file even when `cmd` fails**, leaving a 0-byte file that still passes `integrity_check`. Always check file size, or write to a temp name and `mv` on success:
   ```bash
   ... | base64 -d > snap.tmp && mv snap.tmp snap_final.db
   ```
5. **SQLite WAL mode**: never copy only the `.db`; the newest data can be in `-wal`. Use the backup API (above) or `.backup`, and delete `-wal`/`-shm` when swapping files.
6. **Never overwrite a DB the running app has open.** Upload as `.new`, swap, restart immediately.
7. **`railway ssh` needs a running container**, so deploy once before uploading.
8. **Admin panel "archive view" is read-only.** While it is active the admin panel shows the archived semester, not live data. Exit the archive view to see live records.
9. Printing the variables file exposes every secret. If that happens, rotate the secrets.

## 6. Runbook for the next migration (condensed)

Trial status is visible in the Railway dashboard (it showed about **30 days or $5.00 left** on Nov 8, 2026). Start a few days before expiry.

1. `git remote set-url origin <new-repo-url> && git push -u origin main`
2. Old account (`railway whoami`), linked folder: snapshot both DBs (3.3) and run `railway variables --kv` to a private file (3.4).
3. Create the new project from the new repo, attach a volume at `/data`, paste variables (minus `RAILWAY_*`), deploy once.
4. Switch accounts: `railway logout && railway login`, new SSH key if needed (3.6), `railway link` to the new project.
5. Just before the old trial ends: take a **fresh** snapshot from the old project (data changes after the first backup), remove the domain from the old service.
6. Upload as `.new`, verify, swap, restart (3.7). Add the domain to the new service with the right port (3.8).
7. Test login (including Google), then check users, rooms, billing, and logs.
8. Only then let the old project expire. Keep local backups.

## 7. Open items

- Rotate secrets that were exposed in terminal/chat output: GitHub token, Gmail/Google OAuth credentials and refresh token, Gmail app password, SendGrid keys, Cloudinary secret, Gemini API keys, and `SESSION_SECRET`.
- Change the default admin passwords.
- Store the local backups (`~/PGADAIMS/*.db`, `*.sql`, env files) somewhere safe outside the repo.
