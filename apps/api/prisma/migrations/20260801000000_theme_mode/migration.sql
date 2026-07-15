-- A light/dark toggle chosen alongside the website template, not by the
-- customer on the live site. See the ThemeMode enum's comment in schema.prisma.
CREATE TYPE "ThemeMode" AS ENUM ('LIGHT', 'DARK');

ALTER TABLE "restaurants" ADD COLUMN "themeMode" "ThemeMode" NOT NULL DEFAULT 'LIGHT';
