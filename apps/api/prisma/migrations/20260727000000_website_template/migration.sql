-- Three genuinely different storefront layouts, and how the header shows
-- logo vs restaurant name. See the enum comments in schema.prisma.
CREATE TYPE "WebsiteTemplate" AS ENUM ('CLASSIC', 'BOLD', 'MINIMAL');
CREATE TYPE "LogoDisplayMode" AS ENUM ('LOGO_AND_NAME', 'LOGO_ONLY', 'NAME_ONLY');

ALTER TABLE "restaurants" ADD COLUMN "websiteTemplate" "WebsiteTemplate" NOT NULL DEFAULT 'CLASSIC';
ALTER TABLE "restaurants" ADD COLUMN "logoDisplayMode" "LogoDisplayMode" NOT NULL DEFAULT 'LOGO_AND_NAME';
