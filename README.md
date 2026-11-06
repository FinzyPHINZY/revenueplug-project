# RevenuePlug

**Revenue recovery co-pilot for subscription-based businesses.**

Plug in Stripe. Find your revenue leaks. Stop churn before it happens.

---
## 🎯 What is RevenuePlug?

A SaaS that automatically analyzes revenue leaks in subscription businesses and fixes them.

**Core Value Proposition:**
- **"We recovered $1,247 for you this month—automatically."**

### The Problem

SaaS companies lose 5-10% of revenue to:
- Failed payments (expired cards, insufficient funds)
- Preventable churn (at-risk customers)
- Poor dunning management
- Manual recovery processes

Founders don't realize how much they're bleeding until it's too late.

### The Solution

RevenuePlug connects to your Stripe account and:
1. **Identifies** where you're losing revenue (failed payments, at-risk customers)
2. **Recovers** lost revenue through automated email campaigns
3. **Prevents** future churn with proactive risk detection
4. **Proves ROI** with exact dollar amounts recovered

---

## 🏗️ Technical Architecture

**Production-grade backend foundation built for scale:**

- **Multi-platform architecture** (Stripe, Polar, RevenueCat, LemonSqueezy)
- **Event-driven** (Postgres → Kafka → ClickHouse)
- **TypeScript strict mode** (catch bugs at compile time)
- **Encrypted credentials** (AES-256-GCM for platform credentials)
- **Graceful degradation** (health checks, graceful shutdown)

### Tech Stack

**Backend:**
- Node.js 20 + TypeScript (strict)
- Fastify (API server)
- Prisma (ORM)
- Kafka (event streaming)
- ClickHouse (analytics)
- BullMQ + Redis (background jobs)

**Infrastructure:**
- Postgres (source of truth)
- Redis (cache + queues)
- Kafka (events)
- ClickHouse (analytics)

**Platform Adapters:**
- Stripe ✅
- Polar ✅ (scaffolded)
- RevenueCat (future)
- LemonSqueezy (future)

---

## 📊 Project Status

**Current Phase:** Foundation Complete ✅

**Next Phase:** Phase 0 Validation (landing page + customer discovery)

**Timeline to Launch:** 6-8 weeks

**Goal:** $10,000 MRR in 6 months

---

## 🎓 Key Principles

### Product
1. **One killer feature** > many mediocre features
2. **Time-to-value under 5 minutes** (instant ROI demonstration)
3. **Focus beats features** (Stripe-only for Phase 1-2)

### Engineering
1. **Modular monolith first**, microservices when needed
2. **Managed services** over self-hosting (optimize for time-to-market)
3. **Event-driven from day 1** (analytics never impacts prod DB)

### Business
1. **Pricing = value captured**, not costs
2. **MRR-based tiers** ($29-299, aligns with customer success)
3. **Distribution = Stripe partnership** (listed in marketplace)

---

## 💰 Business Model

### Pricing Tiers

- **Starter:** $29/mo (up to $10k MRR tracked)
- **Growth:** $99/mo (up to $50k MRR tracked) ⭐ Sweet spot
- **Pro:** $299/mo (up to $250k MRR tracked)
- **Enterprise:** Custom (unlimited MRR)

### Value Proposition

**For $99/month, customers get:**
- Automated failed payment recovery (typically recovers $500-5,000/month)
- Churn risk detection and prevention
- Revenue analytics dashboard
- Slack notifications
- ROI: 5-50x return on investment

---


## 🏁 Getting Started

### For Development

```bash
# 1. Install dependencies
pnpm install

# 2. Start infrastructure (Postgres, Redis, Kafka, ClickHouse)
docker compose up -d

# 3. Generate Prisma client
pnpm prisma:generate

# 4. Run migrations
pnpm prisma:migrate:dev

# 5. Start dev server
pnpm dev
```

Visit `http://localhost:3000/health` to verify setup.

---
## 🤝 Contributing

This is a solo/small-team project focused on speed to market.


**Principles:**
- TypeScript strict mode (no exceptions)
- Test critical paths (not 100% coverage)
- Document architectural decisions (ADRs)
- Keep modules decoupled

---

## 📄 License

MIT

---

## 🙏 Acknowledgments

**Influenced by:**
- ProfitWell (metrics, but free tier too limited)
- Baremetrics (great UI, too expensive)
- ChartMogul (powerful, but slow time-to-value)

**Built with:**
- [Fastify](https://www.fastify.io/)
- [Prisma](https://www.prisma.io/)
- [Kafka](https://kafka.apache.org/)
- [ClickHouse](https://clickhouse.com/)
