/**
 * `npm run setup` — the first-run check.
 *
 * It does not install anything or ask questions. It looks at what is actually on
 * this machine and in your .env, then tells you the ONE next thing to do.
 *
 * That is the point. A twelve-step README is a document you read; a command that
 * says "you are on step 3, run this" is a thing you can follow while tired.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

/** Run a command, return its output, or null if it isn't installed / fails. */
function tryRun(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function readEnv() {
  const path = join(root, '.env');
  if (!existsSync(path)) return null;

  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

const steps = [];
let blocked = false;

/** Record a step. `next` is what to run/do if it isn't done. */
function step(name, done, next, detail) {
  steps.push({ name, done, next, detail });
  if (!done) blocked = true;
  return done;
}

// --- 1. Tools ---------------------------------------------------------------

const nodeMajor = Number(process.versions.node.split('.')[0]);
step(
  `Node 20+ (you have ${process.versions.node})`,
  nodeMajor >= 20,
  'Install Node 20 or newer: https://nodejs.org',
);

const docker = tryRun('docker --version');
step(
  'Docker installed',
  Boolean(docker),
  'Install Docker Desktop and start it: https://docker.com/products/docker-desktop',
  docker ? dim(docker) : undefined,
);

// --- 2. .env ----------------------------------------------------------------

let env = readEnv();

if (!env) {
  if (existsSync(join(root, '.env.example'))) {
    copyFileSync(join(root, '.env.example'), join(root, '.env'));
    console.log(green('\n  Created .env from .env.example.\n'));
    env = readEnv();
  }
}

step('.env exists', Boolean(env), 'cp .env.example .env');

/**
 * The four the API refuses to boot without — deliberately, because a missing Stripe
 * secret should crash at startup and not at 7pm on a Friday when a customer pays.
 */
const REQUIRED = [
  ['DATABASE_URL', 'Use postgresql://orderos:orderos@localhost:5432/orderos for local Docker'],
  ['CLERK_SECRET_KEY', 'clerk.com -> API keys -> sk_test_...'],
  ['CLERK_PUBLISHABLE_KEY', 'clerk.com -> API keys -> pk_test_...'],
  ['STRIPE_SECRET_KEY', 'dashboard.stripe.com (TEST mode) -> API keys -> sk_test_...'],
];

/**
 * A key is "set" only if it is present AND is not the placeholder.
 *
 * `.env.example` ships `sk_test_xxxxxxxx` so the shape is obvious. A naive presence
 * check passes on that — and then the API boots perfectly happily and dies at the
 * first Stripe call with an authentication error, which reads like our bug rather
 * than an unfilled form. Placeholders are worse than blanks precisely because they
 * look filled in.
 */
const isPlaceholder = (v) => !v || /x{4,}/i.test(v) || v.includes('your-') || v === 'changeme';

const missing = env
  ? REQUIRED.filter(([k]) => isPlaceholder(env[k])).map(([k, hint]) => `${k}  ${dim(hint)}`)
  : [];

step(
  'Required keys are set in .env',
  env !== null && missing.length === 0,
  missing.length ? `Fill these in:\n       ${missing.join('\n       ')}` : 'Create .env first',
);

// Stripe Connect is easy to forget and its absence only shows up when a restaurant
// tries to onboard — at which point it looks like OUR bug.
if (env?.STRIPE_SECRET_KEY && !isPlaceholder(env.STRIPE_SECRET_KEY)) {
  console.log(
    yellow('\n  Reminder:') +
      ' Stripe -> Connect -> Get started must be enabled, or restaurant\n' +
      '  onboarding fails with a confusing error. It is free and takes a minute.\n',
  );
}

// --- 3. Infrastructure ------------------------------------------------------

const pgUp = tryRun('docker ps --filter name=orderos-postgres --filter status=running -q');
const redisUp = tryRun('docker ps --filter name=orderos-redis --filter status=running -q');

step('Postgres running', Boolean(pgUp), 'npm run infra:up');
step('Redis running', Boolean(redisUp), 'npm run infra:up');

// --- 4. Database ------------------------------------------------------------

let migrated = false;
if (pgUp && env?.DATABASE_URL) {
  // `migrate status` exits non-zero when migrations are pending, which is exactly
  // the signal we want.
  migrated = tryRun('npm run db:status --workspace=@orderos/api') !== null;
}
step(
  'Migrations applied',
  migrated,
  'npm run db:deploy',
  migrated ? undefined : dim('This is the first time they will ever run against a real database.'),
);

// --- 5. Webhook -------------------------------------------------------------

step(
  'Stripe webhook secret set',
  !isPlaceholder(env?.STRIPE_WEBHOOK_SECRET),
  'In a 2nd terminal:  stripe listen --forward-to localhost:4000/api/payments/webhook\n' +
    '       Then paste the printed whsec_... into .env as STRIPE_WEBHOOK_SECRET and restart the API.',
);

// --- Report -----------------------------------------------------------------

console.log(bold('\n  OrderOS setup\n'));

for (const s of steps) {
  console.log(`  ${s.done ? green('OK  ') : red('TODO')}  ${s.name}`);
  if (s.detail) console.log(`        ${s.detail}`);
}

const nextStep = steps.find((s) => !s.done);

if (nextStep) {
  console.log(bold('\n  Next:\n'));
  console.log(`    ${nextStep.next}\n`);
  console.log(dim('  Then run `npm run setup` again.\n'));
  process.exit(1);
}

console.log(bold('\n  Everything is ready.\n'));
console.log('    npm run dev      ' + dim('API on :4000, web on :3000'));
console.log('    npm run db:seed  ' + dim('a demo restaurant, if you want one'));
console.log('    npm run smoke    ' + dim('checks it actually works'));
console.log(`
  ${bold('Then do the one thing that matters:')}

    1. Sign up at http://localhost:3000/sign-up
    2. Dashboard -> Get set up -> menu, fulfillment, Stripe
    3. Go live
    4. Order something, pay with 4242 4242 4242 4242
    5. Watch it reach PAID in Dashboard -> Orders

  Until that works, nothing else does.
`);
