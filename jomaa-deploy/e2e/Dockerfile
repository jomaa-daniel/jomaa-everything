# jerry: systemd as PID 1, a lingering deployment user without sudo, Python, Git, Node.js and the real cloudflared.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG TARGETARCH
ARG NODE_VERSION
ARG NODE_DIST
ARG CLOUDFLARED_FILE
ARG CLOUDFLARED_PATH
ARG JERRY_USER
ARG JERRY_UID
ARG GIT_ROOT
ARG EDGE_DIRECTORY
ARG EDGE_CONFIG_ENV
ARG EDGE_CONFIG

ENV container=docker \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        systemd dbus dbus-user-session libpam-systemd polkitd \
        python3 git ca-certificates curl xz-utils openssl procps iproute2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN systemctl mask \
        systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
        systemd-modules-load.service systemd-remount-fs.service systemd-firstboot.service \
        sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount \
        getty.target console-getty.service

RUN case "${TARGETARCH}" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) exit 1 ;; esac \
    && curl -fsSL "${NODE_DIST}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
        | tar -xJ -C /usr/local --strip-components=1 \
    && node --version && npm --version

COPY --chmod=755 ${CLOUDFLARED_FILE} ${CLOUDFLARED_PATH}
RUN "${CLOUDFLARED_PATH}" --version

RUN if id -u "${JERRY_UID}" >/dev/null 2>&1; then userdel -r "$(id -nu "${JERRY_UID}")" || true; fi \
    && useradd --create-home --uid "${JERRY_UID}" --shell /bin/bash "${JERRY_USER}" \
    && mkdir -p /var/lib/systemd/linger "${GIT_ROOT}" "${EDGE_DIRECTORY}" \
    && touch "/var/lib/systemd/linger/${JERRY_USER}" \
    && chown "${JERRY_USER}:${JERRY_USER}" "${GIT_ROOT}" \
    && mkdir -p /etc/systemd/user.conf.d \
    && printf '[Manager]\nDefaultEnvironment=%s=%s\n' "${EDGE_CONFIG_ENV}" "${EDGE_CONFIG}" \
        > /etc/systemd/user.conf.d/jomaa-e2e.conf

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
