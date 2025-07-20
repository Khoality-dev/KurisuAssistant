FROM python:3.10.18-bullseye

RUN mkdir /app
RUN pip install --upgrade pip
ADD ./requirements.txt /app/
WORKDIR /app
RUN pip install -r requirements.txt

ADD . /app
CMD ["python", "main.py"]