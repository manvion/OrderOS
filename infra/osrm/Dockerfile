# Self-hosted OSRM — reliable, keyless driving directions for the courier map.
#
# The public OSRM demo server (router.project-osrm.org) rate-limits and times out, which
# is why routes so often fell back to a straight line. This runs YOUR own OSRM against a
# regional OpenStreetMap extract, so directions are fast and always available.
#
# On first boot the entrypoint downloads the extract named by OSRM_PBF_URL and runs the
# one-time preprocessing (extract/partition/customize). The result is cached in the /data
# volume, so restarts start serving immediately.
FROM osrm/osrm-backend:v5.27.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Processed graph + downloaded extract live here — mount a persistent volume so the
# (potentially long) preprocessing runs once, not on every deploy.
VOLUME /data
EXPOSE 5000

ENTRYPOINT ["/entrypoint.sh"]
