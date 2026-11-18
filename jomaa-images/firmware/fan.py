"""Hardware PWM fan output with acknowledged, revisioned hub settings."""
import json
import machine
import time

SETTINGS_FILE = "fan_settings.json"
MAX_PERCENT = 100
MAX_DUTY = 65535
REPORT_ACTION = "fan/report"


class Fan:
    def __init__(self, boot_id, install_id):
        with open(SETTINGS_FILE) as source:
            self.settings = json.load(source)
        self.boot_id = boot_id
        self.install_id = install_id
        self.revision = None
        self.sequence = 0
        self.pending = None
        self.due = time.ticks_ms()
        duty = self._duty(self.settings["startupPercent"])
        self.pwm = machine.PWM(machine.Pin(self.settings["gpio"]),
                               freq=self.settings["frequencyHz"], duty_u16=duty)
        self.percent = self.settings["startupPercent"]

    def _duty(self, percent):
        duty = (percent * MAX_DUTY + MAX_PERCENT // 2) // MAX_PERCENT
        return MAX_DUTY - duty if self.settings["inverted"] else duty

    def state(self):
        duty = self.pwm.duty_u16()
        logical = MAX_DUTY - duty if self.settings["inverted"] else duty
        return {"bootId": self.boot_id, "installId": self.install_id,
                "sequence": self.sequence, "appliedRevision": self.revision,
                "percentCurrent": (logical * MAX_PERCENT + MAX_DUTY // 2) // MAX_DUTY,
                "gpio": self.settings["gpio"], "frequencyHz": self.pwm.freq(),
                "inverted": self.settings["inverted"]}

    def exchange(self, client):
        if time.ticks_diff(time.ticks_ms(), self.due) < 0:
            return
        if self.pending is None:
            self.pending = self.state()
        response = client.post(self.pending, REPORT_ACTION)
        command = response["command"]
        revision, percent = command["revision"], command["percentSetting"]
        if (type(revision) is not int or revision < 0 or
                (self.revision is not None and revision < self.revision) or
                type(percent) is not int or not 0 <= percent <= MAX_PERCENT or
                (revision == self.revision and percent != self.percent)):
            raise ValueError("Invalid fan command")
        self.pwm.duty_u16(self._duty(percent))
        self.percent = percent
        self.revision = revision
        self.pending = None
        self.sequence += 1
        self.due = time.ticks_add(time.ticks_ms(), self.settings["pollMilliseconds"])
