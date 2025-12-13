FROM pytorch/pytorch:2.7.0-cuda11.8-cudnn9-runtime

RUN apt-get update && apt-get install -y \
    git \
    ffmpeg

RUN mkdir /app
RUN pip install --upgrade pip
ADD ./requirements.txt /app/
WORKDIR /app
RUN pip install -r requirements.txt

ADD . /app

# Copy and set up entrypoint script
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 15597
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["uvicorn", "llm_hub:app", "--host", "0.0.0.0", "--port", "15597"]
