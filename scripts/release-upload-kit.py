#!/usr/bin/env python3
"""Make a one-time upload link so a Mac WITHOUT AWS credentials can publish a build.

Run this where AWS credentials exist (it signs; nothing is uploaded yet):

    python3 scripts/release-upload-kit.py            # valid 12 hours
    python3 scripts/release-upload-kit.py --hours 48

It prints one command. On the Mac, that command runs scripts/mac-release.sh, which builds
the app and PUTs exactly four files through pre-signed URLs:

    desktop/releases/<version>/OpenKT-<version>-arm64.dmg   (immutable)
    desktop/releases/<version>/OpenKT-<version>-arm64.zip   (immutable)
    desktop/OpenKT-latest-arm64.dmg                         (openkt.ai's download)
    desktop/latest.json                                     (the in-app updater's feed, written last)

The kit can write only those four keys, only until it expires, and cannot read or delete anything.
The kit itself is stored at upload-kits/<random>.json (private) and handed over as a pre-signed GET.
"""
import argparse, datetime, json, secrets, sys

try:
    import botocore.session
except ImportError:  # the AWS CLI v1 ships botocore with the system python
    sys.exit("botocore not found: run with the python that runs the AWS CLI, e.g. /usr/bin/python3")

BUCKET = "openkt-downloads-724772068721"
REGION = "ap-south-1"
BASE = f"https://{BUCKET}.s3.{REGION}.amazonaws.com"
LONG = "public, max-age=31536000, immutable"

ap = argparse.ArgumentParser()
ap.add_argument("--hours", type=float, default=12)
ap.add_argument("--version", help="default: 0.3.<YYMMDDHHMM> (UTC, now)")
a = ap.parse_args()

version = a.version or "0.3." + datetime.datetime.now(datetime.timezone.utc).strftime("%y%m%d%H%M")
ttl = int(a.hours * 3600)
s3 = botocore.session.get_session().create_client("s3", region_name=REGION,
        config=botocore.config.Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))

def put(key, content_type, cache_control):
    url = s3.generate_presigned_url("put_object", ExpiresIn=ttl,
            Params={"Bucket": BUCKET, "Key": key, "ContentType": content_type, "CacheControl": cache_control})
    return {"key": key, "url": url, "public_url": f"{BASE}/{key}", "content_type": content_type, "cache_control": cache_control}

rel = f"desktop/releases/{version}"
kit = {
    "version": version,
    "expires_at": (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=ttl)).isoformat(timespec="seconds"),
    "dmg": put(f"{rel}/OpenKT-{version}-arm64.dmg", "application/x-apple-diskimage", LONG),
    "zip": put(f"{rel}/OpenKT-{version}-arm64.zip", "application/zip", LONG),
    "latest_dmg": put("desktop/OpenKT-latest-arm64.dmg", "application/x-apple-diskimage", "no-cache"),
    "feed": put("desktop/latest.json", "application/json", "no-cache"),
}
kit_key = f"upload-kits/{secrets.token_urlsafe(18)}.json"
s3.put_object(Bucket=BUCKET, Key=kit_key, Body=json.dumps(kit, indent=1).encode(), ContentType="application/json")
kit_url = s3.generate_presigned_url("get_object", ExpiresIn=ttl, Params={"Bucket": BUCKET, "Key": kit_key})

print(f"Upload kit for OpenKT {version}, valid until {kit['expires_at']}. On the Mac, run:\n")
print(f"curl -fsSL https://raw.githubusercontent.com/masti-ai/OpenKT-ai/main/scripts/mac-release.sh | OPENKT_UPLOAD_KIT='{kit_url}' bash")
