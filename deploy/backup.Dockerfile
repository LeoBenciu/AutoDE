FROM quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z AS minio-client
FROM postgres:16-bookworm

COPY --from=minio-client /usr/bin/mc /usr/local/bin/mc
COPY deploy/backup.sh /usr/local/bin/backup.sh
COPY deploy/restore.sh /usr/local/bin/restore.sh
RUN chmod 0555 /usr/local/bin/backup.sh /usr/local/bin/restore.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
