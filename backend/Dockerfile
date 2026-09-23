FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-runtime

RUN apt-get update && apt-get install -y \
    git \
    ffmpeg \
    g++

RUN mkdir /app
RUN pip install --upgrade pip
ADD ./requirements.txt /app/
WORKDIR /app
RUN pip install -r requirements.txt

# The application itself, copied last so a code change does not reinstall the
# wheels above it.
#
# Copied rather than mounted: the image is the deployable artefact, and it has
# to carry the code it runs. With the source bind-mounted instead, the running
# server was whatever the host checkout happened to be at that moment — a
# `git checkout` in that directory swapped the live code under a running
# process, and the image alone could not be run anywhere. The dev overlay
# mounts the source back over this on purpose; production does not.
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
COPY scripts /app/scripts
COPY kurisuassistant /app/kurisuassistant

# The release this image is (#291): `git describe --tags` in the checkout it was
# built from, passed by Compose. A release tag reads as that release; anything
# else, or nothing, reports itself as a dev build. Last, so a new version reuses
# every layer above.
ARG KURISU_VERSION=
ENV KURISU_VERSION=${KURISU_VERSION}

# Runtime state lives here and is bind-mounted by Compose; the directory is
# created so the image is still runnable on its own.
RUN mkdir -p /app/data

EXPOSE 15597
CMD ["/app/docker-entrypoint.sh"]
