ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY root/ /
USER 65532:65532
WORKDIR /workspace
ENV HOME=/work/home TMPDIR=/tmp LANG=C.UTF-8 TZ=UTC PATH=/usr/bin:/bin
ENTRYPOINT ["/opt/executor/entrypoint"]
