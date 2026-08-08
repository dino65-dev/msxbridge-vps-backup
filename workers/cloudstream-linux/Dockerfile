FROM gradle:8.13-jdk21 AS build
WORKDIR /workspace
COPY settings.gradle.kts build.gradle.kts ./
COPY src ./src
RUN gradle --no-daemon installDist

FROM eclipse-temurin:21-jre-jammy
RUN useradd --system --create-home --uid 10001 worker && mkdir -p /var/lib/msxbridge/plugins && chown -R worker:worker /var/lib/msxbridge
WORKDIR /opt/msxbridge-worker
COPY --from=build /workspace/build/install/msxbridge-cloudstream-linux ./
USER worker
ENV PLUGIN_DIR=/var/lib/msxbridge/plugins
EXPOSE 8081
CMD ["/opt/msxbridge-worker/bin/msxbridge-cloudstream-linux"]
