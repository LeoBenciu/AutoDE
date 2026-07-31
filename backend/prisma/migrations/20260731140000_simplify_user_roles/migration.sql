-- ACCOUNTANT becomes the administrative role. Existing OWNER and MANAGER
-- accounts retain access by being migrated to ACCOUNTANT.
CREATE TYPE "Role_new" AS ENUM ('ACCOUNTANT', 'SALES', 'VIEWER');

ALTER TABLE "User"
ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "User"
ALTER COLUMN "role" TYPE "Role_new"
USING (
  CASE
    WHEN "role"::text IN ('OWNER', 'MANAGER') THEN 'ACCOUNTANT'
    ELSE "role"::text
  END
)::"Role_new";

DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";

ALTER TABLE "User"
ALTER COLUMN "role" SET DEFAULT 'VIEWER';
