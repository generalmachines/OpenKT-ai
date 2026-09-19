# CI on AWS

GitHub Actions is **disabled** for this repository. The owner decided to run CI only on AWS; GitHub hosts the code and sends webhooks, which do not use Actions minutes. The workflow files in `.github/workflows/` are kept for reference only. They do not run.

| What | Where | Status |
|---|---|---|
| Server deploy on push to `main` | CodeBuild `openkt-ai-deploy` (us-east-1), `.codebuild/deploy.yml` | live |
| Pull-request checks (packages, desktop unit tests on Linux, server, plugin manifests) | CodeBuild `openkt-ai-pr-checks` (us-east-1), `.codebuild/pr-checks.yml` | live, reports the `openkt-ai-pr-checks` status |
| macOS app: DMG + zip, published to the S3 update feed | `.codebuild/desktop-release.yml` | **prepared, not connected**: needs a Mac the owner has to approve |

Source access for all projects goes through the CodeConnections GitHub connection `openkt-github` (us-east-1, GitHub App). Source download takes about 4 s. Before this, `openkt-landing-build` used the account-wide GitHub token, and its source download took about a minute or hung.

## macOS builds: the options

Apple silicon Macs on AWS are dedicated hosts with a **24-hour minimum** per allocation. Mumbai (ap-south-1) only offers Intel `mac1`, so the arm64 build belongs in us-east-1. These are on-demand prices from the AWS Price List API, 2026-09-19:

| Option | Hardware | Price | Minimum | Always on (730 h) |
|---|---|---|---|---|
| CodeBuild macOS reserved-capacity fleet, `reserved.arm.m2.medium` | M2, 8 vCPU, 24 GiB | $0.020 / min = **$1.20 / h** | 24 h per instance ($28.80) | $876 / month |
| CodeBuild macOS fleet, `reserved.arm.m2.large` | M2 Pro, 12 vCPU, 32 GiB | $0.036 / min = $2.16 / h | 24 h ($51.84) | $1,577 / month |
| EC2 Mac dedicated host `mac2` (mac2.metal) | M1, 8 cores, 16 GiB | **$0.65 / h** | 24 h ($15.60) | $474.50 / month |
| EC2 Mac dedicated host `mac2-m2` (mac2-m2.metal) | M2, 24 GiB | $0.878 / h | 24 h ($21.07) | $641 / month |
| EC2 Mac dedicated host `mac-m4` (mac-m4.metal) | M4 | $1.23 / h | 24 h ($29.52) | $898 / month |

- **Reserved-capacity fleets** bill for as long as the fleet exists, whether or not a build is running.
- **EC2 Mac hosts** bill from allocation until release, and cannot be released inside the first 24 hours.
- **EBS** comes on top of either option. The app build needs about 100 GB of gp3, about $8 / month at us-east-1 rates (approximate).

**Cheapest way that works:** allocate one `mac2` host in us-east-1 only on release days. Run `.codebuild/desktop-release.yml`'s commands on it, as a CodeBuild fleet or directly over SSM, then release the host after 24 h. That costs **$15.60 per release day**. A CodeBuild fleet is simpler to operate (webhook-triggered, logs and status like the other projects) but costs at least $28.80 per day it exists.

**Quota:** this account's EC2 quota for every Mac host type in us-east-1 is **0** (`Running Dedicated mac2 Hosts` = 0, quota code `L-5D8DADF5`). A quota increase has to be requested and granted before any host can be allocated, and AWS can take hours to days to grant it.

**What the owner must approve before anything is created:**
1. Which option: an EC2 `mac2` host at $15.60 per release day, or a CodeBuild macOS fleet at $28.80 or more per day.
2. Whether it stays on all the time or is allocated only for each release.
3. Filing the Mac host quota increase in us-east-1.

Signing and notarisation also need an Apple Developer ID ($99 / year, not AWS). Builds stay ad-hoc signed until one exists.
