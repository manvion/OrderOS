-- Restaurant-level content language, driving the AI-fill language options.
CREATE TYPE "MenuLanguage" AS ENUM ('EN', 'FR', 'BOTH');
ALTER TABLE "restaurants" ADD COLUMN "menuLanguage" "MenuLanguage" NOT NULL DEFAULT 'EN';
