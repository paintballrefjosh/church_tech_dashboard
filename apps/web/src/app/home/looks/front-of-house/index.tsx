"use client";

import { Barlow, Barlow_Condensed } from "next/font/google";
import type { LookProps } from "../../look-props";
import { useHomeSnapshot } from "../../use-home-snapshot";
import { LookPickerButton } from "../../picker/look-picker";
import { Scene } from "./scene";
import { Bank } from "./bank";
import { ChecklistCard, HelpDeskCard, TeamCard } from "./deck";
import s from "./front-of-house.module.css";

const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-foh",
  display: "swap",
});
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-foh-cond",
  display: "swap",
});

/** Front of House: a mixing console. Presentation only; the data is the home snapshot plus `meters`. */
export default function FrontOfHouseLook(props: LookProps) {
  const { snapshot, refresh } = useHomeSnapshot(props.snapshot, ["meters"]);
  const live: LookProps = { ...props, snapshot };
  const hasTeam = snapshot.service.state === "ok" && snapshot.service.data.team !== null;

  return (
    <main
      data-look="front-of-house"
      className={`${s.root} ${barlow.variable} ${barlowCondensed.variable} ${props.kiosk ? s.kiosk : ""}`}
    >
      <div className={s.wrap}>
        <Scene props={live} />
        <Bank
          snapshot={snapshot}
          meId={props.me.id}
          onChanged={() => void refresh()}
          tools={
            props.kiosk ? null : (
              <LookPickerButton className={s.pickerBtn} />
            )
          }
        />
        <div className={s.deck}>
          {hasTeam ? <TeamCard snapshot={snapshot} /> : null}
          <ChecklistCard snapshot={snapshot} refresh={refresh} />
          <HelpDeskCard props={live} />
        </div>
      </div>
    </main>
  );
}
