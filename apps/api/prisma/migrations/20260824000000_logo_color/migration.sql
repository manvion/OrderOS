-- Recolour the logo mark (ORIGINAL / WHITE / BLACK) so it reads over the media hero.
ALTER TABLE "restaurants" ADD COLUMN "logoColor" TEXT NOT NULL DEFAULT 'ORIGINAL';
