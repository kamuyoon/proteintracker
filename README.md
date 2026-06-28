# 🥩 프로틴 트래커

쿠팡 단백질 식품 가격 실시간 추적 서비스.  
매 **2시간마다** 쿠팡 파트너스 링크를 통해 자동으로 가격을 파싱하고, 90일 데이터 기반으로 저점·고점을 분석합니다.

---

## 🚀 Railway 배포 (무료, 5분)

### 1. GitHub에 업로드

```bash
git init
git add .
git commit -m "init protein tracker"
# GitHub에서 새 레포 만들고:
git remote add origin https://github.com/YOUR_USERNAME/protein-tracker.git
git push -u origin main
```

### 2. Railway 배포

1. [railway.app](https://railway.app) 가입 (GitHub 로그인)
2. **New Project → Deploy from GitHub repo** 선택
3. 이 레포 선택 → 자동 배포 시작

### 3. 환경변수 설정 (Railway 대시보드)

Railway → Variables 탭에서:

| 변수명 | 값 | 설명 |
|--------|-----|------|
| `ADMIN_KEY` | `비밀번호를_복잡하게` | 어드민 패널 접근 키 |
| `SITE_URL` | `https://xxx.up.railway.app` | Railway 제공 URL |
| `DB_PATH` | `/data/data.db` | (볼륨 추가 후) |

### 4. 영구 DB 볼륨 추가

Railway → **Add Volume** → Mount Path: `/data`  
그리고 `DB_PATH=/data/data.db` 설정

### 5. 도메인 확인

Railway 대시보드 → **Settings → Domains** → 자동 생성된 URL 복사  
예: `https://protein-tracker-production.up.railway.app`

---

## 🔍 Google 검색 노출 (SEO)

### 1. Google Search Console 등록

1. [search.google.com/search-console](https://search.google.com/search-console) 접속
2. **URL 접두어** 방식으로 사이트 추가: `https://your-domain.railway.app`
3. 인증 방법: **HTML 태그** 선택 → `<meta name="google-site-verification" content="...">` 코드 복사
4. `public/index.html`의 `<head>` 안에 붙여넣기 → Git push → Railway 재배포
5. Search Console에서 **인증 완료** 클릭

### 2. 사이트맵 제출

Search Console → **사이트맵** → `https://your-domain.railway.app/sitemap.xml` 입력 후 제출

### 3. 색인 요청

Search Console → **URL 검사** → 사이트 URL 입력 → **색인 생성 요청**

### 4. public/index.html 에서 도메인 업데이트

```html
<!-- 이 부분들을 실제 도메인으로 교체 -->
<link rel="canonical" href="https://실제도메인.railway.app/">
<meta property="og:url" content="https://실제도메인.railway.app/">
```

---

## ⚙️ 사용법

### 쿠팡 파트너스 링크 연결

1. 사이트 오른쪽 상단 **⚙ 관리** 클릭
2. `ADMIN_KEY` 입력
3. **링크 설정** 탭 → 각 상품 옆에 쿠팡 파트너스 링크 입력
4. **저장** → 즉시 가격 자동 파싱 시작

링크 형태: `https://coupa.ng/XXXXXXX` (쿠팡 파트너스에서 발급한 개별 링크)

### 자동 업데이트

- 매 2시간마다 서버가 자동으로 전 상품 가격 파싱
- 수동 업데이트: 관리 → **운영** 탭 → **전체 가격 지금 업데이트**

---

## 🛠 로컬 개발

```bash
npm install
cp .env.example .env
# .env 편집 후:
npm run dev
# http://localhost:3000 접속
```

---

## 📁 구조

```
protein-tracker-server/
├── server.js          # 백엔드 (Express + SQLite + 가격 파싱 + 크론)
├── public/
│   └── index.html     # 프론트엔드 (Apple 다크 UI)
├── package.json
├── .env.example
├── .gitignore
└── Procfile           # Railway/Heroku 실행 명령
```

---

## ⚠️ 주의사항

- 쿠팡은 개별 파트너스 링크가 있어야 함 (공통 계정 링크 아님)
- 가격 파싱 실패 시 어드민에서 수동 입력 가능
- 쿠팡 HTML 구조 변경 시 `server.js`의 `fetchCoupangInfo()` 수정 필요
- **반드시** `ADMIN_KEY`를 복잡한 값으로 변경 (기본값 사용 금지)

---

## 📢 법적 고지

이 서비스는 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.
