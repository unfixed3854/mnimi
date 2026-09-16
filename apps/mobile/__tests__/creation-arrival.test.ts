import { creationArrivalMotion } from "@/features/create/creation-arrival";

describe("creation arrival motion", () => {
  it("uses a short staggered translation for newly completed cards", () => {
    expect(creationArrivalMotion("card", false, 2)).toEqual({
      duration: 220,
      delay: 120,
      translate: true,
    });
  });

  it("uses opacity only without a stagger when reduced motion is active", () => {
    expect(creationArrivalMotion("card", true, 4)).toEqual({
      duration: 120,
      delay: 0,
      translate: false,
    });
    expect(creationArrivalMotion("image", true, 0)).toEqual({
      duration: 120,
      delay: 0,
      translate: false,
    });
  });
});
