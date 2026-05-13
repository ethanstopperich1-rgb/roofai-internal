/**
 * Auto-generated Supabase types. DO NOT EDIT by hand.
 *
 * Regenerate after every schema migration:
 *   mcp__supabase__generate_typescript_types({ project_id: "htfhelquuvndfwfwqjmd" })
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      calls: {
        Row: {
          agent_name: string
          caller_number: string | null
          created_at: string
          duration_sec: number | null
          ended_at: string | null
          estimated_cost_usd: number | null
          id: string
          lead_id: string | null
          llm_completion_tokens: number | null
          llm_prompt_tokens: number | null
          office_id: string
          outcome: string | null
          room_name: string
          started_at: string
          stt_secs: number | null
          summary: string | null
          transcript: string | null
          tts_chars: number | null
          turn_count: number | null
        }
        Insert: {
          agent_name: string
          caller_number?: string | null
          created_at?: string
          duration_sec?: number | null
          ended_at?: string | null
          estimated_cost_usd?: number | null
          id?: string
          lead_id?: string | null
          llm_completion_tokens?: number | null
          llm_prompt_tokens?: number | null
          office_id: string
          outcome?: string | null
          room_name: string
          started_at: string
          stt_secs?: number | null
          summary?: string | null
          transcript?: string | null
          tts_chars?: number | null
          turn_count?: number | null
        }
        Update: {
          agent_name?: string
          caller_number?: string | null
          created_at?: string
          duration_sec?: number | null
          ended_at?: string | null
          estimated_cost_usd?: number | null
          id?: string
          lead_id?: string | null
          llm_completion_tokens?: number | null
          llm_prompt_tokens?: number | null
          office_id?: string
          outcome?: string | null
          room_name?: string
          started_at?: string
          stt_secs?: number | null
          summary?: string | null
          transcript?: string | null
          tts_chars?: number | null
          turn_count?: number | null
        }
        Relationships: []
      }
      consents: {
        Row: {
          call_id: string | null
          consent_type: string
          consented_at: string
          disclosure_text: string
          email: string | null
          id: string
          ip_address: unknown
          lead_id: string | null
          office_id: string
          phone: string | null
          user_agent: string | null
        }
        Insert: {
          call_id?: string | null
          consent_type: string
          consented_at?: string
          disclosure_text: string
          email?: string | null
          id?: string
          ip_address?: unknown
          lead_id?: string | null
          office_id: string
          phone?: string | null
          user_agent?: string | null
        }
        Update: {
          call_id?: string | null
          consent_type?: string
          consented_at?: string
          disclosure_text?: string
          email?: string | null
          id?: string
          ip_address?: unknown
          lead_id?: string | null
          office_id?: string
          phone?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      events: {
        Row: {
          at: string
          call_id: string | null
          id: string
          office_id: string
          payload: Json
          type: string
        }
        Insert: {
          at?: string
          call_id?: string | null
          id?: string
          office_id: string
          payload: Json
          type: string
        }
        Update: {
          at?: string
          call_id?: string | null
          id?: string
          office_id?: string
          payload?: Json
          type?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          address: string
          assigned_at: string | null
          assigned_to: string | null
          county: string | null
          created_at: string
          email: string
          estimate_high: number | null
          estimate_low: number | null
          estimated_sqft: number | null
          id: string
          lat: number | null
          lng: number | null
          material: string | null
          name: string
          notes: string | null
          office_id: string
          phone: string | null
          public_id: string
          selected_add_ons: string[] | null
          source: string | null
          status: string
          tcpa_consent: boolean
          tcpa_consent_at: string | null
          tcpa_consent_text: string | null
          updated_at: string
          zip: string | null
        }
        Insert: {
          address: string
          assigned_at?: string | null
          assigned_to?: string | null
          county?: string | null
          created_at?: string
          email: string
          estimate_high?: number | null
          estimate_low?: number | null
          estimated_sqft?: number | null
          id?: string
          lat?: number | null
          lng?: number | null
          material?: string | null
          name: string
          notes?: string | null
          office_id: string
          phone?: string | null
          public_id: string
          selected_add_ons?: string[] | null
          source?: string | null
          status?: string
          tcpa_consent?: boolean
          tcpa_consent_at?: string | null
          tcpa_consent_text?: string | null
          updated_at?: string
          zip?: string | null
        }
        Update: {
          address?: string
          assigned_at?: string | null
          assigned_to?: string | null
          county?: string | null
          created_at?: string
          email?: string
          estimate_high?: number | null
          estimate_low?: number | null
          estimated_sqft?: number | null
          id?: string
          lat?: number | null
          lng?: number | null
          material?: string | null
          name?: string
          notes?: string | null
          office_id?: string
          phone?: string | null
          public_id?: string
          selected_add_ons?: string[] | null
          source?: string | null
          status?: string
          tcpa_consent?: boolean
          tcpa_consent_at?: string | null
          tcpa_consent_text?: string | null
          updated_at?: string
          zip?: string | null
        }
        Relationships: []
      }
      offices: {
        Row: {
          brand_color: string | null
          created_at: string
          id: string
          inbound_number: string | null
          is_active: boolean
          livekit_agent_name: string | null
          logo_url: string | null
          name: string
          slug: string
          state: string | null
          twilio_number: string | null
        }
        Insert: {
          brand_color?: string | null
          created_at?: string
          id?: string
          inbound_number?: string | null
          is_active?: boolean
          livekit_agent_name?: string | null
          logo_url?: string | null
          name: string
          slug: string
          state?: string | null
          twilio_number?: string | null
        }
        Update: {
          brand_color?: string | null
          created_at?: string
          id?: string
          inbound_number?: string | null
          is_active?: boolean
          livekit_agent_name?: string | null
          logo_url?: string | null
          name?: string
          slug?: string
          state?: string | null
          twilio_number?: string | null
        }
        Relationships: []
      }
      proposals: {
        Row: {
          created_at: string
          generated_by: string | null
          id: string
          lead_id: string | null
          office_id: string
          pdf_url: string | null
          public_id: string
          snapshot: Json
          total_high: number | null
          total_low: number | null
        }
        Insert: {
          created_at?: string
          generated_by?: string | null
          id?: string
          lead_id?: string | null
          office_id: string
          pdf_url?: string | null
          public_id: string
          snapshot: Json
          total_high?: number | null
          total_low?: number | null
        }
        Update: {
          created_at?: string
          generated_by?: string | null
          id?: string
          lead_id?: string | null
          office_id?: string
          pdf_url?: string | null
          public_id?: string
          snapshot?: Json
          total_high?: number | null
          total_low?: number | null
        }
        Relationships: []
      }
      users: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
          office_id: string
          role: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          office_id: string
          role?: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          office_id?: string
          role?: string
        }
        Relationships: []
      }
      // ─── ADDED BY MIGRATIONS 0004 + 0005 ─────────────────────────────
      // These three table types were added by hand to keep the build
      // green pending a real Supabase types regeneration. After you
      // apply migrations 0004_sms_opt_outs.sql and 0005_canvass_targets.sql
      // to the live DB, regenerate via:
      //   mcp__supabase__generate_typescript_types({ project_id: "htfhelquuvndfwfwqjmd" })
      // and these hand-rolled definitions will be replaced with the
      // exact shape the DB emits.
      sms_opt_outs: {
        Row: {
          phone_e164: string
          office_id: string | null
          opted_out_at: string
          source: string
          keyword: string | null
          opted_in_at: string | null
        }
        Insert: {
          phone_e164: string
          office_id?: string | null
          opted_out_at?: string
          source?: string
          keyword?: string | null
          opted_in_at?: string | null
        }
        Update: {
          phone_e164?: string
          office_id?: string | null
          opted_out_at?: string
          source?: string
          keyword?: string | null
          opted_in_at?: string | null
        }
        Relationships: []
      }
      storm_events: {
        Row: {
          id: string
          region_name: string
          center_lat: number
          center_lng: number
          radius_miles: number
          event_date: string
          peak_inches: number
          hit_count: number
          ground_reports: number
          source: string
          detected_at: string
          office_id: string | null
        }
        Insert: {
          id?: string
          region_name: string
          center_lat: number
          center_lng: number
          radius_miles: number
          event_date: string
          peak_inches: number
          hit_count: number
          ground_reports?: number
          source?: string
          detected_at?: string
          office_id?: string | null
        }
        Update: {
          id?: string
          region_name?: string
          center_lat?: number
          center_lng?: number
          radius_miles?: number
          event_date?: string
          peak_inches?: number
          hit_count?: number
          ground_reports?: number
          source?: string
          detected_at?: string
          office_id?: string | null
        }
        Relationships: []
      }
      canvass_targets: {
        Row: {
          id: string
          office_id: string
          storm_event_id: string
          address_line: string | null
          city: string | null
          state: string | null
          zip: string | null
          lat: number
          lng: number
          score: number
          distance_miles: number | null
          status: string
          contacted_at: string | null
          responded_at: string | null
          lead_id: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          office_id: string
          storm_event_id: string
          address_line?: string | null
          city?: string | null
          state?: string | null
          zip?: string | null
          lat: number
          lng: number
          score?: number
          distance_miles?: number | null
          status?: string
          contacted_at?: string | null
          responded_at?: string | null
          lead_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          office_id?: string
          storm_event_id?: string
          address_line?: string | null
          city?: string | null
          state?: string | null
          zip?: string | null
          lat?: number
          lng?: number
          score?: number
          distance_miles?: number | null
          status?: string
          contacted_at?: string | null
          responded_at?: string | null
          lead_id?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_office_id: { Args: Record<string, never>; Returns: string }
      is_admin: { Args: Record<string, never>; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
