#!/usr/bin/env python3
"""Push messagewall project to GitHub and trigger CI."""
import subprocess, json, urllib.request, os, sys

BASE = "C:/Users/MRGy/WorkBuddy/2026-08-24-22-44-07/messagewall"
TOKEN = "***REDACTED***"
OWNER = "gybeyond1"
REPO = "messagewall"

def run(cmd, **kwargs):
    r = subprocess.run(cmd, shell=True, cwd=BASE, capture_output=True, text=True, **kwargs)
    if r.returncode != 0:
        print(f"  ERR: {r.stderr.strip()}", file=sys.stderr)
    return r.stdout.strip()

# 1. Create GitHub repo
print("Creating GitHub repo...")
url = "https://api.github.com/user/repos"
data = json.dumps({"name": REPO, "private": True, "auto_init": False}).encode()
req = urllib.request.Request(url, data=data, headers={
    "Authorization": f"token {TOKEN}",
    "Content-Type": "application/json",
    "Accept": "application/vnd.github.v3+json",
})
try:
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read().decode())
        clone_url = result["clone_url"]
        print(f"Repo created: {clone_url}")
except urllib.error.HTTPError as e:
    body = e.read().decode()
    if e.code == 422:
        print("Repo already exists, fetching URL...")
        req2 = urllib.request.Request(
            f"https://api.github.com/repos/{OWNER}/{REPO}",
            headers={"Authorization": f"token {TOKEN}"}
        )
        with urllib.request.urlopen(req2) as resp2:
            clone_url = json.loads(resp2.read().decode())["clone_url"]
            print(f"Using existing repo: {clone_url}")
    else:
        print(f"HTTP Error {e.code}: {body[:200]}")
        sys.exit(1)

# 2. Git add, commit, push
print("Staging files...")
run("git add -A")
print("Committing...")
run('git commit -m "chore: initial commit - messagewall v1.0"')
print(f"Adding remote and pushing to {clone_url}...")
run(f'git remote add origin {clone_url}')
run("git push -u origin main")

print("\nDone! GitHub Actions will now build and push the Docker image.")
