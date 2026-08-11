ALTER TABLE "Vehicle"
ADD COLUMN "draftSourceDocumentId" INTEGER;

CREATE UNIQUE INDEX "Vehicle_draftSourceDocumentId_key"
ON "Vehicle"("draftSourceDocumentId");

ALTER TABLE "Vehicle"
ADD CONSTRAINT "Vehicle_draftSourceDocumentId_fkey"
FOREIGN KEY ("draftSourceDocumentId") REFERENCES "Document"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
