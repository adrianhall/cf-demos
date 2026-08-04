import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { emptyUsageSummary } from "../composables/useChatAgent";
import AdminReportTable from "./AdminReportTable.vue";

describe("AdminReportTable", () => {
  it("shows an empty state when there is no usage recorded yet", () => {
    const wrapper = mount(AdminReportTable, {
      props: { labelHeader: "Business", rows: [] },
    });

    expect(wrapper.text()).toContain("No usage recorded yet.");
    expect(wrapper.find("table").exists()).toBe(false);
  });

  it("renders the supplied header and every row's label with its cost badge", () => {
    const wrapper = mount(AdminReportTable, {
      props: {
        labelHeader: "Business",
        rows: [
          {
            label: "Leadership",
            usage: { ...emptyUsageSummary(), totalCostUsd: 0.4 },
          },
          {
            label: "Unspecified",
            usage: emptyUsageSummary(),
          },
        ],
      },
    });

    expect(wrapper.get("thead th").text()).toBe("Business");
    const rows = wrapper.findAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.get('th[scope="row"]').text()).toBe("Leadership");
    expect(rows[0]?.get(".usage-badge").text()).toContain("0.4000");
    expect(rows[1]?.get('th[scope="row"]').text()).toBe("Unspecified");
  });

  it("renders rows in the order supplied, without re-sorting", () => {
    const wrapper = mount(AdminReportTable, {
      props: {
        labelHeader: "Geo",
        rows: [
          { label: "APAC", usage: emptyUsageSummary() },
          { label: "EMEA", usage: emptyUsageSummary() },
        ],
      },
    });

    const labels = wrapper.findAll('th[scope="row"]').map((el) => el.text());
    expect(labels).toEqual(["APAC", "EMEA"]);
  });
});
