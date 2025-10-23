# Sneaker Store — Backend (Serverless API Template)

A serverless REST API (AWS SAM + API Gateway + Lambda + Aurora/RDS MySQL) with public read endpoints and **JWT-protected** admin endpoints. Although this template uses “shoes”, you can adapt it to any product catalog.

> Replace anything in angle brackets like `<YOUR_VALUE>` with your real values.

---

## Live URLs 
- Frontend: https://dxfbbjnnl2x5b.cloudfront.net/
- API (dev): https://b5gwibc2nd.execute-api.us-east-1.amazonaws.com/dev

---

## 🏗️ Architecture (high level)
```
[User Browser]
   │
   │  loads SPA (HTML/CSS/JS/images)
   ▼
[CloudFront CDN] ──► [S3 (private, OAC-only)]

[User Browser]
   │
   │  HTTPS (Authorization: Bearer <JWT> on admin calls)
   ▼
[API Gateway (REST) + JWT Authorizer]
   │
   ▼
[Lambda (Node 20, in VPC)] ──(IAM)──► [Aurora/RDS MySQL]

```
- **Authorizer:** JWT authorizer on admin routes; `NONE` on selected public routes (e.g., `/images` if desired).
- **Networking:** Lambdas run inside a VPC (private subnets) with SG rules to reach the DB.
- **Deploy:** `sam build` + `sam deploy` via `template.yaml`.

---

## 📡 Endpoints
```
GET    /shoes                      # list products (public)
GET    /shoes/{id}                 # product detail (public)
POST   /shoes                      # create product (JWT required)
PUT    /shoes/{id}                 # update product fields (JWT required)
PATCH  /shoes/{id}/inventory       # upsert inventory rows (JWT required)
DELETE /shoes/{id}                 # delete product (JWT required)
GET    /images                     # list image keys under a prefix (public, optional)
```
- Attach a **JWT authorizer** to POST/PUT/PATCH/DELETE.
- Frontend sends `Authorization: Bearer <JWT>` on admin endpoints.

---

## 📦 Code Layout (high level)
```
src/
  handlers/
    getShoes.js
    getshoe.js               # single item detail
    updateShoes.js           # create/update + inventory upsert
    deleteShoes.js
    seedShoes.js             # optional one-time data seeder
    imageList.js             # lists S3 objects under a prefix
  lib/
    config.js                # loads DB config from env or Secrets Manager
    db.js                    # mysql2 pooled connection helper
template.yaml                # SAM template (API, functions, params)
```

---

## ⚙️ Configuration & Env Vars
Choose one **config mode** in `lib/config.js`:

**A) Env mode**
```
CONFIG_SOURCE=Env
DB_HOST=<YOUR_DB_ENDPOINT>
DB_PORT=3306
DB_NAME=<YOUR_DB_NAME>
DB_USER=<YOUR_DB_USER>
DB_PASSWORD=<YOUR_DB_PASSWORD>

# CORS
CORS_ORIGIN=https://<YOUR_CLOUDFRONT_DOMAIN>

# Optional (images endpoint)
IMAGES_BUCKET=<YOUR_S3_BUCKET>
IMAGES_PREFIX=<YOUR_IMAGES_PREFIX>        # e.g., images/
IMAGE_PUBLIC_BASE=https://<YOUR_CDN_OR_CLOUDFRONT_DOMAIN>/
```

**B) Secrets Manager mode**
```
CONFIG_SOURCE=SecretsManager
SECRET_NAME=<YOUR_DB_SECRET_NAME>         # JSON: { host, username, password, dbname, port }
CORS_ORIGIN=https://<YOUR_CLOUDFRONT_DOMAIN>

# Optional (images endpoint)
IMAGES_BUCKET=<YOUR_S3_BUCKET>
IMAGES_PREFIX=<YOUR_IMAGES_PREFIX>
IMAGE_PUBLIC_BASE=https://<YOUR_CDN_OR_CLOUDFRONT_DOMAIN>/
```

> For non-secret values you can also use **SSM Parameter Store** dynamic refs in `template.yaml`:
> `DB_HOST: "{{resolve:ssm:/yourapp/db/host}}"` (resolved at deploy time).

---

## 🔑 Parameters to provide at deploy
Provide these via `sam deploy --guided` or `--parameter-overrides` (names may vary in your template):

| Parameter                  | Example / Notes                                  |
|---------------------------|---------------------------------------------------|
| `VpcId`                   | `<vpc-xxxxxxxx>`                                  |
| `LambdaSubnetIds`         | `<subnet-a,subnet-b>` (private subnets)           |
| `LambdaSecurityGroupIds`  | `<sg-xxxxxxxx>` (egress to DB/VPC endpoints)      |
| `CognitoUserPoolArn` or JWT config | Authorizer source (if using Cognito)     |
| `DbPassword` / `SecretName` | Choose Env or Secrets Manager path              |
| `ImagesBucket` / `ImagesPrefix` (optional) | For the `/images` endpoint       |
| `CorsOrigin`              | `https://<YOUR_CLOUDFRONT_DOMAIN>`                |

**Helpful Output** (add to `template.yaml`):
```yaml
Outputs:
  ApiBaseUrl:
    Description: Base URL for this API
    Value: !Sub "https://${<YOUR_API_REF>}.execute-api.${AWS::Region}.amazonaws.com/<YOUR_STAGE>"
```

---

## 🧪 Local Development
Run the API locally with **SAM** and an env file.

**`env.local.json.example`**
```json
{
  "Parameters": { "DbPassword": "local-dev-only" },
  "YourFunctionLogicalId": {
    "CONFIG_SOURCE": "Env",
    "DB_HOST": "127.0.0.1",
    "DB_USER": "root",
    "DB_PASSWORD": "local-dev-only",
    "DB_NAME": "sneakerdb",
    "CORS_ORIGIN": "http://localhost:5173",

    "IMAGES_BUCKET": "<YOUR_S3_BUCKET>",
    "IMAGES_PREFIX": "images/",
    "IMAGE_PUBLIC_BASE": "http://localhost:5173/"
  }
}
```

Start:
```bash
sam local start-api --env-vars env.local.json
# API runs on http://localhost:3000
```

Point your frontend at:
```
VITE_API_BASE=http://localhost:3000
```

---

## 🧱 Data Model
```sql
shoes(
  id BIGINT PK AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  brand VARCHAR(100) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  image VARCHAR(512) NOT NULL        -- CDN URL (e.g., /images/<file>)
)
```

```sql
shoe_inventory(
  id BIGINT PK AUTO_INCREMENT,
  shoe_id BIGINT NOT NULL,           -- FK -> shoes.id
  size DECIMAL(3,1) NOT NULL,        -- supports 7.5, 9.5, 10.0, 11.5, etc.
  quantity INT NOT NULL,
  UNIQUE (shoe_id, size)             -- one row per size per shoe
  -- optionally add: FOREIGN KEY (shoe_id) REFERENCES shoes(id) ON DELETE CASCADE
)
```

---

## 🔐 Auth & CORS
- Use a **JWT authorizer** (Cognito or any OIDC provider) on POST/PUT/PATCH/DELETE.
- Frontend sends: `Authorization: Bearer <JWT>`.
- **Production CORS**: set `CORS_ORIGIN=https://<YOUR_CLOUDFRONT_DOMAIN>`.

---

## 📡 Request Examples
```bash
# Public list
curl -s "$API_BASE/shoes" | jq .

# Admin create
curl -X POST "$API_BASE/shoes"   -H "Authorization: Bearer $TOKEN"   -H "Content-Type: application/json"   -d '{ "name":"Air Zoom", "brand":"Nike", "price":129.99, "image":"https://<YOUR_CDN_OR_CLOUDFRONT_DOMAIN>/images/zoom.jpg" }'

# Upsert inventory
curl -X PATCH "$API_BASE/shoes/123/inventory"   -H "Authorization: Bearer $TOKEN"   -H "Content-Type: application/json"   -d '{ "items":[{"size":8,"quantity":5},{"size":9.5,"quantity":2}] }'
```

---

## 🐞 Troubleshooting
- **CORS blocked**: `CORS_ORIGIN` doesn’t match your frontend URL.
- **401/403 on writes**: missing/expired JWT or insufficient claims.
- **Timeouts**: Lambda can’t reach DB (VPC, route tables, SG rules).
- **Empty `/images`**: verify bucket/prefix and IAM permission; set `IMAGES_*` envs.

---

## 📈 Monitoring & Cleanup
- **Logs**: CloudWatch Logs (JSON). **Tracing**: enable X-Ray if desired.
- **Costs**: Aurora/RDS and VPC endpoints can incur charges when idle.
- **Delete**: `sam delete` tears down the stack.

---

## 🔒 Security Notes
- Prefer SAM-managed roles with **least-privilege** policies (avoid hardcoded ARNs).
- Keep DB in **private subnets**; allow inbound only from the **Lambda SG**.
- Use **Secrets Manager / SSM** for credentials; never commit secrets.
- Consider throttling/usage plans and **WAF** on API Gateway.

---

## 📦 Error Model (suggested)
- Standard HTTP codes; JSON body:
```json
{ "message": "validation failed", "code": "VALIDATION_ERROR" }
```

---

## License
MIT 

