import { getLocation } from "@calcom/lib/CalEventParser";
import logger from "@calcom/lib/logger";
import type {
  CalendarEvent,
  EventBusyDate,
  IntegrationCalendar,
  NewCalendarEventType,
} from "@calcom/types/Calendar";
import type { CredentialPayload } from "@calcom/types/Credential";
import type { ContactCreateInput, CRM, Contact } from "@calcom/types/CrmService";

import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";
import { invalidateCredential } from "../../_utils/invalidateCredential";
import { OAuthManager } from "../../_utils/oauth/OAuthManager";
import { getTokenObjectFromCredential } from "../../_utils/oauth/getTokenObjectFromCredential";
import { oAuthManagerHelper } from "../../_utils/oauth/oAuthManagerHelper";
import appConfig from "../config.json";

type PipedriveContact = {
  id: number;
  name: string;
  first_name: string;
  last_name: string;
  emails: Array<{ value: string; primary: boolean }>;
};

type PipedriveActivity = {
  id: number;
  subject: string;
  due_date: string;
  due_time: string;
  duration: string;
  note: string;
  location: string;
  person_id: number;
};

type PipedriveApiResponse<T> = {
  success: boolean;
  data?: T;
};

type PipedriveSearchResponse = {
  success: boolean;
  data?: {
    items: Array<{
      item: PipedriveContact;
    }>;
  };
};

type PipedriveCredentialKey = {
  api_domain: string;
};

export default class PipedriveCrmService implements CRM {
  private log: typeof logger;
  private auth: OAuthManager;
  private apiDomain: string;
  private credential: CredentialPayload;

  constructor(credential: CredentialPayload) {
    this.log = logger.getSubLogger({ prefix: [`[[lib] ${appConfig.slug}`] });
    this.credential = credential;

    const key = credential.key as PipedriveCredentialKey;
    this.apiDomain = key.api_domain;

    const tokenResponse = getTokenObjectFromCredential(credential);
    this.auth = new OAuthManager({
      credentialSyncVariables: oAuthManagerHelper.credentialSyncVariables,
      resourceOwner: {
        type: "user",
        id: credential.userId,
      },
      appSlug: appConfig.slug,
      currentTokenObject: tokenResponse,
      fetchNewTokenObject: async ({ refreshToken }: { refreshToken: string | null }) => {
        if (!refreshToken) {
          return null;
        }

        const appKeys = await getAppKeysFromSlug(appConfig.slug);
        let clientId = "";
        let clientSecret = "";
        if (typeof appKeys.client_id === "string") clientId = appKeys.client_id;
        if (typeof appKeys.client_secret === "string") clientSecret = appKeys.client_secret;

        if (!clientId || !clientSecret) {
          throw new Error("Pipedrive client credentials missing for token refresh");
        }

        const authHeader = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;

        return fetch("https://oauth.pipedrive.com/oauth/token", {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        });
      },
      isTokenObjectUnusable: async function (response) {
        if (!response.ok || response.status < 200 || response.status >= 300) {
          try {
            const responseBody = await response.json();
            if (responseBody.error === "invalid_grant") {
              return {
                reason: "invalid_grant",
              };
            }
          } catch (e) {
            // If we can't parse the response, we can't determine if it's unusable
          }
        }
        return null;
      },
      isAccessTokenUnusable: async function (response) {
        if (!response.ok || response.status < 200 || response.status >= 300) {
          try {
            const responseBody = await response.json();
            if (responseBody.error === "invalid_token" || response.status === 401) {
              return {
                reason: "invalid_token",
              };
            }
          } catch (e) {
            // If we can't parse the response, we can't determine if it's unusable
          }
        }
        return null;
      },
      invalidateTokenObject: () => invalidateCredential(credential.id),
      expireAccessToken: () => oAuthManagerHelper.markTokenAsExpired(credential),
      updateTokenObject: async (tokenObject) => {
        await oAuthManagerHelper.updateTokenObject({ tokenObject, credentialId: credential.id });
        // Update cached api_domain if it changed
        const tokenWithApiDomain = tokenObject as typeof tokenObject & { api_domain?: string };
        if (tokenWithApiDomain.api_domain) {
          this.apiDomain = tokenWithApiDomain.api_domain;
        }
      },
    });
  }



  async createContacts(contactsToCreate: ContactCreateInput[]): Promise<Contact[]> {
    const result = contactsToCreate.map(async (attendee) => {
      const [firstName, lastName] = !!attendee.name ? attendee.name.split(" ") : [attendee.email, ""];

      const bodyData = {
        name: attendee.name || attendee.email,
        first_name: firstName,
        last_name: lastName || "",
        emails: [{ value: attendee.email, primary: true }],
      };

      try {
        const { json } = await this.auth.request({
          url: `${this.apiDomain}/api/v2/persons`,
          options: {
            method: "POST",
            body: JSON.stringify(bodyData),
          },
        });

        const result = json as PipedriveApiResponse<PipedriveContact>;
        if (result.success && result.data) {
          const contact = result.data;
          return {
            id: contact.id.toString(),
            email: contact.emails[0]?.value || attendee.email,
            firstName: contact.first_name,
            lastName: contact.last_name,
            name: contact.name,
          };
        }
        throw new Error("Failed to create contact");
      } catch (error) {
        this.log.error("Error creating contact:", error);
        throw error;
      }
    });

    return await Promise.all(result);
  }

  async getContacts({ emails }: { emails: string | string[] }): Promise<Contact[]> {
    const emailArray = Array.isArray(emails) ? emails : [emails];

    const result = emailArray.map(async (email) => {
      try {
        const { json } = await this.auth.request({
          url: `${this.apiDomain}/api/v2/persons/search?term=${encodeURIComponent(email)}&fields=email`,
          options: {
            method: "GET",
          },
        });

        const result = json as PipedriveSearchResponse;
        if (result.success && result.data?.items) {
          return result.data.items.map((item) => {
            const contact = item.item;
            return {
              id: contact.id.toString(),
              email: contact.emails[0]?.value || email,
              firstName: contact.first_name,
              lastName: contact.last_name,
              name: contact.name,
            };
          });
        }
        return [];
      } catch (error) {
        this.log.error("Error searching contacts:", error);
        return [];
      }
    });

    const results = await Promise.all(result);
    return results.flat();
  }

  private getMeetingBody = (event: CalendarEvent): string => {
    return `${event.organizer.language.translate("invitee_timezone")}: ${
      event.attendees[0].timeZone
    }\n\n${event.organizer.language.translate("share_additional_notes")}\n${event.additionalNotes || "-"}`;
  };

  private createPipedriveActivity = async (
    event: CalendarEvent,
    contacts: Contact[]
  ): Promise<PipedriveApiResponse<PipedriveActivity>> => {
    const startDate = new Date(event.startTime);
    const endDate = new Date(event.endTime);
    const duration = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60));

    const locationString = getLocation(event);
    const activityPayload = {
      subject: event.title,
      type: "meeting",
      due_date: startDate.toISOString().split("T")[0],
      due_time: startDate.toTimeString().split(" ")[0].substring(0, 5),
      duration: `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, "0")}`,
      note: this.getMeetingBody(event),
      ...(locationString && { location: { value: locationString } }),
      participants: [{ person_id: parseInt(contacts[0].id), primary_flag: true }],
    };

    const { json } = await this.auth.request({
      url: `${this.apiDomain}/api/v2/activities`,
      options: {
        method: "POST",
        body: JSON.stringify(activityPayload),
      },
    });

    return json as PipedriveApiResponse<PipedriveActivity>;
  };

  private updateActivity = async (
    uid: string,
    event: CalendarEvent
  ): Promise<PipedriveApiResponse<PipedriveActivity>> => {
    const startDate = new Date(event.startTime);
    const endDate = new Date(event.endTime);
    const duration = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60));

    const locationString = getLocation(event);
    const activityPayload = {
      subject: event.title,
      due_date: startDate.toISOString().split("T")[0],
      due_time: startDate.toTimeString().split(" ")[0].substring(0, 5),
      duration: `${Math.floor(duration / 60)}:${(duration % 60).toString().padStart(2, "0")}`,
      note: this.getMeetingBody(event),
      ...(locationString && { location: { value: locationString } }),
    };

    const { json } = await this.auth.request({
      url: `${this.apiDomain}/api/v2/activities/${uid}`,
      options: {
        method: "PATCH",
        body: JSON.stringify(activityPayload),
      },
    });

    return json as PipedriveApiResponse<PipedriveActivity>;
  };

  private deleteActivity = async (uid: string) => {
    const { json } = await this.auth.request({
      url: `${this.apiDomain}/api/v2/activities/${uid}`,
      options: {
        method: "DELETE",
      },
    });

    return json;
  };

  async handleEventCreation(event: CalendarEvent, contacts: Contact[]) {
    const meetingEvent = await this.createPipedriveActivity(event, contacts);

    if (meetingEvent.success && meetingEvent.data) {
      this.log.debug("event:creation:ok", { meetingEvent });
      return Promise.resolve({
        uid: meetingEvent.data.id.toString(),
        id: meetingEvent.data.id.toString(),
        type: appConfig.slug,
        password: "",
        url: "",
        additionalInfo: { contacts, meetingEvent },
      });
    }

    this.log.debug("meeting:creation:notOk", { meetingEvent, event, contacts });
    return Promise.reject("Something went wrong when creating a meeting in PipedriveCRM");
  }

  async createEvent(event: CalendarEvent, contacts: Contact[]): Promise<NewCalendarEventType> {
    return await this.handleEventCreation(event, contacts);
  }

  async updateEvent(uid: string, event: CalendarEvent): Promise<NewCalendarEventType> {
    const meetingEvent = await this.updateActivity(uid, event);

    if (meetingEvent.success && meetingEvent.data) {
      this.log.debug("event:updation:ok", { meetingEvent });
      return Promise.resolve({
        uid: meetingEvent.data.id.toString(),
        id: meetingEvent.data.id.toString(),
        type: appConfig.slug,
        password: "",
        url: "",
        additionalInfo: { meetingEvent },
      });
    }

    this.log.debug("meeting:updation:notOk", { meetingEvent, event });
    return Promise.reject("Something went wrong when updating a meeting in PipedriveCRM");
  }

  async deleteEvent(uid: string): Promise<void> {
    await this.deleteActivity(uid);
  }

  async getAvailability(
    _dateFrom: string,
    _dateTo: string,
    _selectedCalendars: IntegrationCalendar[]
  ): Promise<EventBusyDate[]> {
    return Promise.resolve([]);
  }

  async listCalendars(_event?: CalendarEvent): Promise<IntegrationCalendar[]> {
    return Promise.resolve([]);
  }

  getAppOptions() {
    console.log("No options implemented");
  }

  async handleAttendeeNoShow() {
    console.log("Not implemented");
  }
}
