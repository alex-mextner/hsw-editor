from fastapi import FastAPI

app = FastAPI(title="hsw-vision")


@app.get("/health")
def health() -> dict[str, object]:
    return {"ok": True, "name": "hsw-vision", "version": "0.1.0"}
