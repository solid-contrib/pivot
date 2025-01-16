import { PasswordLoginHandler, JsonView, JsonInteractionHandlerInput, JsonRepresentation, LoginOutputType } from '@solid/community-server';

export class MigratedPasswordLoginHandler extends PasswordLoginHandler implements JsonView {
  public async login(input: JsonInteractionHandlerInput): Promise<JsonRepresentation<LoginOutputType>> {
    const inspect = input as { json: { email: string }};
    if (inspect.json.email.indexOf('@') === -1) {
      // user is logging in with an account that was migrated from an NSS account using
      // https://github.com/RubenVerborgh/NSS2CSS?tab=readme-ov-file#running-the-script
      // this can happen for instance on https://solidcommunity.net, where such a migration
      // happened in December 2024.
      inspect.json.email += '@users.css.pod';
    }
    return super.login(input as JsonInteractionHandlerInput);
  }
}
