import axios, { AxiosRequestConfig } from "axios";
import { config } from "./config.js";
import { tokenManager } from "./token-manager.js";

const client = axios.create({
  baseURL: config.baseUrl,
  headers: { "Content-Type": "application/json" },
  timeout: 10_000,
});

function normalizeError(err: unknown): never {
  if (axios.isAxiosError(err)) {
    const message: string =
      err.response?.data?.message ?? err.response?.data?.error ?? err.message;
    throw new Error(`Backend error (${err.response?.status ?? "network"}): ${message}`);
  }
  throw err;
}

export async function adminApi<T>(
  method: "get" | "post" | "put" | "delete",
  url: string,
  data?: unknown,
  axiosConfig?: AxiosRequestConfig
): Promise<T> {
  try {
    const token = await tokenManager.getToken();
    const res = await client.request<T>({
      method,
      url,
      data,
      ...axiosConfig,
      headers: {
        Authorization: `Bearer ${token}`,
        ...axiosConfig?.headers,
      },
    });
    return res.data;
  } catch (err) {
    normalizeError(err);
  }
}

export async function publicApi<T>(
  method: "get" | "post",
  url: string,
  data?: unknown,
  axiosConfig?: AxiosRequestConfig
): Promise<T> {
  try {
    const res = await client.request<T>({ method, url, data, ...axiosConfig });
    return res.data;
  } catch (err) {
    normalizeError(err);
  }
}
