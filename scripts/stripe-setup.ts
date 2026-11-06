
import Stripe from 'stripe';
import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});


const isLiveMode = process.argv.includes('--live');

if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ Error: STRIPE_SECRET_KEY not found in environment');
  console.error('Please set STRIPE_SECRET_KEY in your .env file');
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-12-18.acacia',
});


const PRODUCTS = [
  {
    name: 'RevenuePlug Starter',
    description: 'For small to medium businesses ready to recover revenue',
    statementDescriptor: 'REVENUEPLUG STARTER',
    prices: {
      monthly: 4900,
      annual: 49000,
    },
    features: [
      '3 platform connections',
      '10,000 API calls/month',
      '1,000 recovery emails/month',
      'Automated recovery campaigns',
      'Webhook integrations',
      'Email support',
    ],
  },
  {
    name: 'RevenuePlug Professional',
    description: 'For growing businesses with multiple platforms',
    statementDescriptor: 'REVENUEPLUG PRO',
    prices: {
      monthly: 14900,
      annual: 149000,
    },
    features: [
      '10 platform connections',
      '100,000 API calls/month',
      '10,000 recovery emails/month',
      'Advanced recovery actions',
      'A/B testing',
      'Priority support',
      'API access',
    ],
  },
  {
    name: 'RevenuePlug Enterprise',
    description: 'For large organizations - Custom pricing available',
    statementDescriptor: 'REVENUEPLUG ENT',
    prices: {
      monthly: 49900,
      annual: 499000,
    },
    features: [
      'Unlimited connections',
      'Unlimited API calls',
      'Unlimited emails',
      'Dedicated infrastructure',
      'Custom integrations',
      'SLA guarantee',
      'Dedicated support',
    ],
  },
];

async function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${message} (y/n): `, (answer) => {
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function createProducts() {
  console.log('\n🚀 RevenuePlug Stripe Setup');
  console.log('========================================\n');

  if (isLiveMode) {
    console.log('⚠️  WARNING: You are about to create products in LIVE MODE');
    console.log('This will affect your production Stripe account.\n');

    const confirmed = await confirm('Are you sure you want to continue?');
    if (!confirmed) {
      console.log('❌ Setup cancelled');
      rl.close();
      process.exit(0);
    }
  } else {
    console.log('ℹ️  Running in TEST MODE\n');
  }

  const results: any = {
    STARTER: {},
    PRO: {},
    ENTERPRISE: {},
  };

  for (let i = 0; i < PRODUCTS.length; i++) {
    const config = PRODUCTS[i];
    const planName = ['STARTER', 'PRO', 'ENTERPRISE'][i];

    console.log(`\n📦 Creating ${config.name}...`);

    try {

      const product = await stripe.products.create({
        name: config.name,
        description: config.description,
        statement_descriptor: config.statementDescriptor,
        metadata: {
          plan: planName.toLowerCase(),
          features: config.features.join(', '),
        },
      });

      console.log(`✓ Product created: ${product.id}`);


      const monthlyPrice = await stripe.prices.create({
        product: product.id,
        unit_amount: config.prices.monthly,
        currency: 'usd',
        recurring: {
          interval: 'month',
        },
        nickname: `${config.name} - Monthly`,
        metadata: {
          plan: planName.toLowerCase(),
          billing_cycle: 'monthly',
        },
      });

      console.log(`✓ Monthly price created: ${monthlyPrice.id} ($${config.prices.monthly / 100}/mo)`);


      const annualPrice = await stripe.prices.create({
        product: product.id,
        unit_amount: config.prices.annual,
        currency: 'usd',
        recurring: {
          interval: 'year',
        },
        nickname: `${config.name} - Annual`,
        metadata: {
          plan: planName.toLowerCase(),
          billing_cycle: 'annual',
        },
      });

      console.log(`✓ Annual price created: ${annualPrice.id} ($${config.prices.annual / 100}/yr)`);


      results[planName] = {
        productId: product.id,
        monthlyPriceId: monthlyPrice.id,
        annualPriceId: annualPrice.id,
      };
    } catch (error) {
      console.error(`❌ Error creating ${config.name}:`, error);
      throw error;
    }
  }

  console.log('\n✅ All products and prices created successfully!\n');
  console.log('========================================');
  console.log('📋 Add these to your .env file:\n');

  console.log('# Monthly pricing');
  console.log(`PRICE_ID_STARTER_MONTHLY="${results.STARTER.monthlyPriceId}"`);
  console.log(`PRICE_ID_PRO_MONTHLY="${results.PRO.monthlyPriceId}"`);
  console.log(`PRICE_ID_ENTERPRISE_MONTHLY="${results.ENTERPRISE.monthlyPriceId}"\n`);

  console.log('# Annual pricing (17% discount)');
  console.log(`PRICE_ID_STARTER_ANNUAL="${results.STARTER.annualPriceId}"`);
  console.log(`PRICE_ID_PRO_ANNUAL="${results.PRO.annualPriceId}"`);
  console.log(`PRICE_ID_ENTERPRISE_ANNUAL="${results.ENTERPRISE.annualPriceId}"`);

  console.log('\n========================================\n');


  const fs = await import('fs');
  const output = `# Stripe Price IDs - Generated ${new Date().toISOString()}
# Mode: ${isLiveMode ? 'LIVE' : 'TEST'}

# Monthly pricing
PRICE_ID_STARTER_MONTHLY="${results.STARTER.monthlyPriceId}"
PRICE_ID_PRO_MONTHLY="${results.PRO.monthlyPriceId}"
PRICE_ID_ENTERPRISE_MONTHLY="${results.ENTERPRISE.monthlyPriceId}"

# Annual pricing (17% discount)
PRICE_ID_STARTER_ANNUAL="${results.STARTER.annualPriceId}"
PRICE_ID_PRO_ANNUAL="${results.PRO.annualPriceId}"
PRICE_ID_ENTERPRISE_ANNUAL="${results.ENTERPRISE.annualPriceId}"
`;

  const filename = isLiveMode ? 'stripe-prices-live.env' : 'stripe-prices-test.env';
  fs.writeFileSync(filename, output);
  console.log(`📄 Price IDs saved to: ${filename}\n`);

  rl.close();
}


createProducts().catch((error) => {
  console.error('\n❌ Setup failed:', error);
  rl.close();
  process.exit(1);
});
