/**
 * Create the FIRST platform admin — you.
 *
 * There is deliberately no UI for this, and no "first user becomes admin" rule.
 * Platform admins live in their own table, and nothing a restaurant can do at their
 * own restaurant grants it; the only way in is a person with database access
 * running this. That is the property we want: the console that can see every
 * restaurant's revenue and suspend any of them cannot be reached by escalating a
 * role inside the product.
 *
 * Usage (after the person has signed up in Clerk — we need their Clerk user id):
 *
 *   npm run admin:create --workspace=@orderos/api -- \
 *     --email you@orderos.ai --clerk-id user_2abc... --role SUPER_ADMIN
 *
 * Re-running with the same email updates the existing row rather than failing, so
 * it is safe to use to fix a typo or promote someone.
 */
import { PrismaClient, PlatformRole } from '@prisma/client';

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const email = arg('email');
  const clerkUserId = arg('clerk-id');
  const name = arg('name');
  const role = (arg('role') ?? 'SUPER_ADMIN') as PlatformRole;

  if (!email || !clerkUserId) {
    console.error(
      'Usage: -- --email you@orderos.ai --clerk-id user_2abc... [--role SUPER_ADMIN|SUPPORT] [--name "Your Name"]\n\n' +
        'The Clerk user id comes from the Clerk dashboard (Users -> the person -> "User ID").\n' +
        'They must have signed up first — we attach admin rights to an existing identity,\n' +
        'we do not mint one.',
    );
    process.exit(1);
  }

  if (role !== 'SUPER_ADMIN' && role !== 'SUPPORT') {
    console.error(`--role must be SUPER_ADMIN or SUPPORT, not "${role}"`);
    process.exit(1);
  }

  const admin = await prisma.platformAdmin.upsert({
    where: { email },
    update: { clerkUserId, role, name, isActive: true },
    create: { email, clerkUserId, role, name },
  });

  console.log(`\n  ${admin.email} is now a platform ${admin.role}.`);
  console.log('  Sign in and open /admin.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
