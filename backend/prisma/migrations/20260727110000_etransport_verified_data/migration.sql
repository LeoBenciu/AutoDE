ALTER TABLE "ETransportDeclaration"
ALTER COLUMN "operationType" DROP DEFAULT,
ADD COLUMN "transportDate" TIMESTAMP(3),
ADD COLUMN "dataVerifiedAt" TIMESTAMP(3);
