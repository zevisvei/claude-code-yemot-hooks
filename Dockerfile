FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim


COPY . /app

ENV UV_NO_DEV=1

WORKDIR /app
RUN uv sync --locked


EXPOSE 8000

CMD ["uv", "run", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]