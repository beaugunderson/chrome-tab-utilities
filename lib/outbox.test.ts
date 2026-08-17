import { describe, expect, it } from "vitest";
import { readwiseRequest, todoistRequest } from "./outbox";

const target = { url: "https://example.com/a", title: "A good article" };

describe("readwiseRequest", () => {
  it("posts to the Reader save endpoint", () => {
    const { endpoint, init } = readwiseRequest("tok", target);
    expect(endpoint).toBe("https://readwise.io/api/v3/save/");
    expect(init.method).toBe("POST");
  });

  it("uses Token auth, not Bearer", () => {
    const { init } = readwiseRequest("tok", target);
    expect((init.headers as Record<string, string>).Authorization).toBe("Token tok");
  });

  it("sends the url and title", () => {
    const body = JSON.parse(readwiseRequest("tok", target).init.body as string);
    expect(body.url).toBe(target.url);
    expect(body.title).toBe(target.title);
  });

  it("omits an absent title rather than sending an empty one", () => {
    const body = JSON.parse(
      readwiseRequest("tok", { url: target.url }).init.body as string,
    );
    expect("title" in body).toBe(false);
  });
});

describe("todoistRequest", () => {
  it("posts to api/v1, since rest/v2 is retired and answers 410", () => {
    const { endpoint } = todoistRequest("tok", target);
    expect(endpoint).toBe("https://api.todoist.com/api/v1/tasks");
    expect(endpoint).not.toContain("rest/v2");
  });

  it("uses Bearer auth, unlike Readwise", () => {
    const { init } = todoistRequest("tok", target);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("puts the title and link in the task content", () => {
    const body = JSON.parse(todoistRequest("tok", target).init.body as string);
    expect(body.content).toContain("A good article");
    expect(body.content).toContain(target.url);
  });

  it("falls back to the bare url when there is no title", () => {
    const body = JSON.parse(
      todoistRequest("tok", { url: target.url }).init.body as string,
    );
    expect(body.content).toBe(target.url);
  });
});
