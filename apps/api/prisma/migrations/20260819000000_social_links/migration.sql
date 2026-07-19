-- The restaurant's own social profiles, shown as an icon row on their storefront.
-- Array of { platform, url }; JSON so a new platform never needs a migration.
ALTER TABLE "restaurants" ADD COLUMN "socialLinks" JSONB;
