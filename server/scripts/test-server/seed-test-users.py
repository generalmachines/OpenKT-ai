#!/usr/bin/env python3
"""Create three test users (an owner, a teammate, a stranger) with access tokens.

Prints SQL on stdout and writes the raw tokens to ./tokens.env (mode 600, never commit it).
    python3 seed-test-users.py | psql "$DATABASE_URL"
    set -a; . ./tokens.env; set +a; node ../live-proof.mjs
"""
import hashlib, os, secrets, uuid

USERS = [("", "Test Owner", "owner@openkt.test"), ("_B", "Test Teammate", "teammate@openkt.test"), ("_C", "Test Stranger", "stranger@openkt.test")]
NS = uuid.UUID("00000000-0000-4000-8000-00000000c0de")
env = ["OPENKT_LIVE_URL=" + os.environ.get("OPENKT_LIVE_URL", "http://127.0.0.1:3300")]
for suffix, name, email in USERS:
    uid = uuid.uuid5(NS, email)
    raw = "okt_pat_" + secrets.token_hex(32)
    digest = hashlib.sha256(raw.encode()).hexdigest()
    print(f"insert into profiles(user_id,email,display_name) values ('{uid}','{email}','{name}') on conflict (user_id) do nothing;")
    print(f"delete from personal_access_tokens where user_id='{uid}' and name='live-test';")
    print(f"insert into personal_access_tokens(user_id,name,token_hash,prefix,scopes) values ('{uid}','live-test','{digest}','{raw[:12]}',ARRAY['read','write']);")
    env.append(f"OPENKT_LIVE_TOKEN{suffix}={raw}")
fd = os.open("tokens.env", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    f.write("\n".join(env) + "\n")
