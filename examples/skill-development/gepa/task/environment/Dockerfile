FROM __DEVELOPMENT_IMAGE__
WORKDIR /workspace/repository
COPY repository/ /workspace/repository/
COPY materials/ /opt/gepa-materials/
# The supplied immutable image provides Node 24, pnpm 11.22.0 and these offline dependencies.
RUN test -d /opt/ember-rsi-deps/node_modules && cp -a /opt/ember-rsi-deps/node_modules /workspace/repository/node_modules
