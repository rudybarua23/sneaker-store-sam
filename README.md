# Sneaker Store — Backend (AWS SAM, Lambda, Aurora MySQL, Cognito + S3)

A serverless REST API built with **AWS SAM** (CloudFormation), **AWS Lambda (Node.js 20)**, **API Gateway**, **Aurora MySQL**, and **Amazon Cognito** (JWT authorizer). It powers the Sneaker Store frontend with CRUD and inventory endpoints, and an S3 image listing endpoint.

---

## 🏗️ Architecture (high level)
```
[CloudFront/S3 (frontend)]  →  HTTPS  →  API Gateway (REST)
                                          ↓
                                      Lambda (Node 20)  →  Aurora MySQL (VPC)
                                          ↓
                              S3 (sneakersbucket-publicfiles, prefix="images/")
                                      Cognito (JWT auth, admin group)
```
- **Authorizer:** `CognitoAuthorizer` on admin‑required routes; `NONE` on some public routes (e.g., /images).
- **Networking:** Lambdas run inside a VPC (private subnets) with SG rules to reach Aurora.
- **Deploy:** `sam build` + `sam deploy` via `template.yaml`.

**Endpoints (from `template.yaml`)**
```
GET    /shoes                  # list shoes (usually public)
POST   /shoes                  # create (admin)
GET    /shoes/{id}             # detail
PUT    /shoes/{id}             # update shoe fields (admin)
PATCH  /shoes/{id}/inventory   # upsert inventory rows (admin)
DELETE /shoes/{id}             # delete (admin)
GET    /images                 # list S3 image objects in a prefix
```

---

## 📦 Code Layout (high level)
```
src/
  handlers/
    getShoes.js
    getshoe.js               # single shoe detail
    updateShoes.js           # updates fields; enforces admin via cognito:groups
    deleteShoes.js
    seedShoes.js             # optional one‑time data seeder
    imageList.js             # lists S3 objects under a prefix
  lib/
    config.js                # loads DB config from env or AWS Secrets Manager
    db.js                    # mysql2 pooled connection helper
template.yaml                # SAM template (functions, authorizer, VPC, params)
```

---

## 🔐 Configuration & Env Vars
Two configuration modes are supported by `lib/config.js`:

**1) Env mode (default)** — set DB connection details directly via env vars  
**2) Secrets Manager mode** — set `CONFIG_SOURCE=SecretsManager` and provide a secret

**Common env vars**
```
# DB (used when CONFIG_SOURCE != SecretsManager)
DB_HOST=<aurora-endpoint>
DB_PORT=3306
DB_NAME=<database>
DB_USER=<username>
DB_PASSWORD=<password>

# Config source
CONFIG_SOURCE=Env               # or SecretsManager
SECRET_NAME=<name-or-arn>       # required when CONFIG_SOURCE=SecretsManager

# CORS
CORS_ORIGIN=https://your-frontend-domain.example   # "*" by default for some handlers

# AWS region hints (some handlers use REGION or AWS_REGION)
AWS_REGION=us-east-1
```

**Secrets Manager value** (JSON)
```json
{
  "host": "your-aurora.cluster-xyz.us-east-1.rds.amazonaws.com",
  "username": "dbuser",
  "password": "P@ssw0rd!",
  "dbname": "sneakerdb",
  "port": 3306
}
```

---

## 🏗️ Build & Deploy with SAM
**Prereqs**: AWS account & credentials, **AWS SAM CLI**, **Node.js 20**

```bash
# from the backend repo root
sam build

# First deploy uses --guided to set parameters (stack name, region, VPC/Subnet/SG, etc.)
sam deploy --guided
```

If you later change code only, you can: `sam build && sam deploy`.

> **Note:** Some handlers (e.g., `imageList.js`) reference S3 bucket/region in code. Update those constants or refactor to env vars/parameters before deploying to a different bucket/region.

---

## 🧪 Local Development
You can run functions locally with `sam local start-api` or `sam local invoke`. For DB access, either:
- Point env vars at a **publicly reachable** test MySQL instance, or
- Use AWS connectivity solutions (e.g., localstack/VPC tunneling).

Example:
```bash
# terminal 1
sam local start-api --env-vars env.local.json

# terminal 2 (seed data once if you have a handler wired for it)
awslocal lambda invoke --function-name SeedShoesFunction out.json
```

---

## 🔒 Authorization
Admin-protected routes expect a **Cognito JWT** with `cognito:groups` including `admin`. When integrating from the frontend, the Amplify v6 `fetchAuthSession()` helper is used to attach the **ID token** in `Authorization: Bearer <idToken>`.

If you prefer validating **access tokens**, update your authorizer & frontend accordingly.

---

## 🗄️ Data Model 
```
shoes(
  id BIGINT PK AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  brand VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  image VARCHAR(512) NOT NULL        
)

shoe_inventory(
  id BIGINT PK AUTO_INCREMENT,
  shoe_id BIGINT NOT NULL            
  size DECIMAL(3,1) NOT NULL,        
  quantity INT NOT NULL,
  UNIQUE (shoe_id, size)             
)
```

---

## 🐞 Troubleshooting
- **CORS errors**: set `CORS_ORIGIN` and confirm API Gateway/Lambda headers align.
- **Timeouts**: verify Lambda can reach Aurora (VPC, SG, route tables, NACLs).
- **Auth 401/403**: ensure Cognito authorizer is configured and your token has `cognito:groups: admin` when needed.
- **Images empty**: confirm the S3 bucket, prefix, and permissions; update handler to your bucket/prefix.

---

## License
MIT 
