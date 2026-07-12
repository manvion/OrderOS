-- The About page: a restaurant's own words, and their own photos.
--
-- `aboutBody` is PLAIN TEXT and is rendered as escaped paragraphs. It is not HTML
-- and it is not markdown. A tenant storing HTML that we then inject into a page
-- served on *.orderos.ai is stored XSS with extra steps.

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN "aboutHeadline" TEXT,
                          ADD COLUMN "aboutBody" TEXT;

-- CreateTable: a row per photo, not a JSON array, because each one owns a blob that
-- has to be deleted when the row goes. An orphaned blob nobody can find is a bill
-- that grows forever.
CREATE TABLE "gallery_images" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "caption" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gallery_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gallery_images_restaurantId_sortOrder_idx" ON "gallery_images"("restaurantId", "sortOrder");

-- AddForeignKey
ALTER TABLE "gallery_images" ADD CONSTRAINT "gallery_images_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
