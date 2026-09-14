FROM python:3.12-alpine

WORKDIR /app
COPY app.py ./
COPY public ./public

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

EXPOSE 8000
CMD ["python", "app.py"]
