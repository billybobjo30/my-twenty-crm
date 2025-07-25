import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import axios, { AxiosInstance } from 'axios';
import uniqBy from 'lodash.uniqby';
import { TWENTY_COMPANIES_BASE_URL } from 'twenty-shared/constants';
import { ConnectedAccountProvider } from 'twenty-shared/types';
import { DeepPartial, ILike, Repository } from 'typeorm';

import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { lowercaseDomainAndRemoveTrailingSlash } from 'src/engine/api/graphql/workspace-query-runner/utils/query-runner-links.util';
import { FieldActorSource } from 'src/engine/metadata-modules/field-metadata/composite-types/actor.composite-type';
import { ObjectMetadataEntity } from 'src/engine/metadata-modules/object-metadata/object-metadata.entity';
import { WorkspaceRepository } from 'src/engine/twenty-orm/repository/workspace.repository';
import { TwentyORMGlobalManager } from 'src/engine/twenty-orm/twenty-orm-global.manager';
import { WorkspaceEventEmitter } from 'src/engine/workspace-event-emitter/workspace-event-emitter';
import { STANDARD_OBJECT_IDS } from 'src/engine/workspace-manager/workspace-sync-metadata/constants/standard-object-ids';
import { CompanyWorkspaceEntity } from 'src/modules/company/standard-objects/company.workspace-entity';
import { extractDomainFromLink } from 'src/modules/contact-creation-manager/utils/extract-domain-from-link.util';
import { getCompanyNameFromDomainName } from 'src/modules/contact-creation-manager/utils/get-company-name-from-domain-name.util';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';
import { computeDisplayName } from 'src/utils/compute-display-name';

export type CompanyToCreate = {
  domainName: string | undefined;
  createdBySource: FieldActorSource;
  createdByWorkspaceMember?: WorkspaceMemberWorkspaceEntity | null;
  createdByContext: {
    provider: ConnectedAccountProvider;
  };
};

@Injectable()
export class CreateCompanyService {
  private readonly httpService: AxiosInstance;

  constructor(
    private readonly twentyORMGlobalManager: TwentyORMGlobalManager,
    private readonly workspaceEventEmitter: WorkspaceEventEmitter,
    @InjectRepository(ObjectMetadataEntity, 'core')
    private readonly objectMetadataRepository: Repository<ObjectMetadataEntity>,
  ) {
    this.httpService = axios.create({
      baseURL: TWENTY_COMPANIES_BASE_URL,
    });
  }

  async createCompanies(
    companies: CompanyToCreate[],
    workspaceId: string,
  ): Promise<{
    [domainName: string]: string;
  }> {
    if (companies.length === 0) {
      return {};
    }

    const objectMetadata = await this.objectMetadataRepository.findOne({
      where: {
        standardId: STANDARD_OBJECT_IDS.company,
        workspaceId,
      },
    });

    if (!objectMetadata) {
      throw new Error('Object metadata not found');
    }

    const companyRepository =
      await this.twentyORMGlobalManager.getRepositoryForWorkspace(
        workspaceId,
        CompanyWorkspaceEntity,
        {
          shouldBypassPermissionChecks: true,
        },
      );

    // Remove trailing slash from domain names
    const companiesWithoutTrailingSlash = companies.map((company) => ({
      ...company,
      domainName: company.domainName
        ? lowercaseDomainAndRemoveTrailingSlash(company.domainName)
        : undefined,
    }));

    // Avoid creating duplicate companies, e.g. example.com and example.com/
    const uniqueCompanies = uniqBy(companiesWithoutTrailingSlash, 'domainName');
    const conditions = uniqueCompanies.map((companyToCreate) => ({
      domainName: {
        primaryLinkUrl: ILike(`%${companyToCreate.domainName}%`),
      },
    }));

    // Find existing companies
    const existingCompanies = await companyRepository.find({
      where: conditions,
    });
    const existingCompanyIdsMap = this.createCompanyMap(existingCompanies);

    // Filter out companies that already exist
    const newCompaniesToCreate = uniqueCompanies.filter(
      (company) =>
        !existingCompanies.some(
          (existingCompany) =>
            existingCompany.domainName &&
            extractDomainFromLink(existingCompany.domainName.primaryLinkUrl) ===
              company.domainName,
        ),
    );

    if (newCompaniesToCreate.length === 0) {
      return existingCompanyIdsMap;
    }

    // Retrieve the last company position
    let lastCompanyPosition =
      await this.getLastCompanyPosition(companyRepository);
    const newCompaniesData = await Promise.all(
      newCompaniesToCreate.map((company) =>
        this.prepareCompanyData(company, ++lastCompanyPosition),
      ),
    );

    // Create new companies
    const createdCompanies = await companyRepository.save(newCompaniesData);

    this.workspaceEventEmitter.emitDatabaseBatchEvent({
      objectMetadataNameSingular: 'company',
      action: DatabaseEventAction.CREATED,
      events: createdCompanies.map((createdCompany) => ({
        recordId: createdCompany.id,
        objectMetadata,
        properties: {
          after: createdCompany,
        },
      })),
      workspaceId,
    });

    const createdCompanyIdsMap = this.createCompanyMap(createdCompanies);

    return {
      ...existingCompanyIdsMap,
      ...createdCompanyIdsMap,
    };
  }

  private async prepareCompanyData(
    company: CompanyToCreate,
    position: number,
  ): Promise<DeepPartial<CompanyWorkspaceEntity>> {
    const { name, city } = await this.getCompanyInfoFromDomainName(
      company.domainName,
    );
    const createdByName = computeDisplayName(
      company.createdByWorkspaceMember?.name,
    );

    return {
      domainName: {
        primaryLinkUrl: 'https://' + company.domainName,
      },
      name,
      createdBy: {
        source: company.createdBySource,
        workspaceMemberId: company.createdByWorkspaceMember?.id,
        name: createdByName,
        context: {
          provider: company.createdByContext.provider,
        },
      },
      address: {
        addressCity: city,
      },
      position,
    };
  }

  private createCompanyMap(companies: DeepPartial<CompanyWorkspaceEntity>[]) {
    return companies.reduce(
      (acc, company) => {
        if (!company.domainName?.primaryLinkUrl || !company.id) {
          return acc;
        }
        const key = extractDomainFromLink(company.domainName.primaryLinkUrl);

        acc[key] = company.id;

        return acc;
      },
      {} as { [domainName: string]: string },
    );
  }

  private async getLastCompanyPosition(
    companyRepository: WorkspaceRepository<CompanyWorkspaceEntity>,
  ): Promise<number> {
    const lastCompanyPosition = await companyRepository.maximum(
      'position',
      undefined,
    );

    return lastCompanyPosition ?? 0;
  }

  private async getCompanyInfoFromDomainName(
    domainName: string | undefined,
  ): Promise<{
    name: string;
    city: string;
  }> {
    try {
      const response = await this.httpService.get(`/${domainName}`);

      const data = response.data;

      return {
        name: data.name ?? getCompanyNameFromDomainName(domainName ?? ''),
        city: data.city,
      };
    } catch (e) {
      return {
        name: getCompanyNameFromDomainName(domainName ?? ''),
        city: '',
      };
    }
  }
}
