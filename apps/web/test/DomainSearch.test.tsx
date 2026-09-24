import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DomainSearch } from "@/components/marketing/DomainSearch";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));

describe("DomainSearch", () => {
  it("asks for a domain when the box is empty", async () => {
    render(<DomainSearch id="heroDomain" hero />);
    await userEvent.click(screen.getByRole("button", { name: /analyze/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your company domain");
    expect(push).not.toHaveBeenCalled();
  });

  it("rejects text that isn't a domain", async () => {
    render(<DomainSearch id="heroDomain" />);
    await userEvent.type(screen.getByLabelText(/your company domain/i), "not a domain{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("doesn't look like a domain");
    expect(push).not.toHaveBeenCalled();
  });

  it("opens onboarding with the cleaned domain", async () => {
    const onDomain = vi.fn();
    render(<DomainSearch id="heroDomain" onDomain={onDomain} />);
    await userEvent.type(screen.getByLabelText(/your company domain/i), "https://www.Northwind.io/about{Enter}");
    expect(push).toHaveBeenLastCalledWith("/onboarding?domain=northwind.io");
    expect(onDomain).toHaveBeenLastCalledWith("northwind.io");
  });

  it("offers a sample domain on the hero", async () => {
    render(<DomainSearch id="heroDomain" hero />);
    await userEvent.click(screen.getByRole("button", { name: /try it with northwind.io/i }));
    expect(push).toHaveBeenLastCalledWith("/onboarding?domain=northwind.io");
  });
});
